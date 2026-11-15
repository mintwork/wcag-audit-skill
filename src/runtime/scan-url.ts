import axe from "axe-core";
import type { Browser, Page } from "playwright-core";
import { fingerprint } from "../static/analyze.js";
import { truncate } from "../static/ast.js";
import type { Finding, ScanResult, Severity } from "../types.js";
import { TOOL } from "../version.js";
import { criteriaFromAxeTags, levelFor } from "../wcag.js";
import { AXE_FIXES } from "./axe-fixes.js";
import { type LaunchOptions, launchBrowser } from "./browser.js";
import { keyboardAudit } from "./keyboard.js";
import { type RuntimeState, runSteps } from "./states.js";

export interface RuntimeOptions extends LaunchOptions {
  /** WCAG level to test against. Default AA. */
  level?: "A" | "AA" | "AAA";
  /** Also run axe best-practice rules (no WCAG mapping). */
  bestPractice?: boolean;
  /** Run Tab-key traversal checks (keyboard trap, focus visible). Default true. */
  keyboard?: boolean;
  /** Re-check each violation to drop flaky / transient results. Default true. */
  verify?: boolean;
  /** CSS selector to wait for before scanning (SPAs). */
  waitFor?: string;
  timeoutMs?: number;
  viewport?: { width: number; height: number };
  /** CSS selectors axe-core should not check (e.g. Storybook's own UI around a story). */
  exclude?: string[];
  /** Don't fail when `waitFor` never appears (a story may legitimately render nothing). */
  waitForOptional?: boolean;
  /** Playwright storage state file (cookies + localStorage) for authenticated pages. */
  storageState?: string;
  colorScheme?: "light" | "dark";
  /** Bring the page into a state (open a modal, dark mode, 320px) before scanning. */
  state?: RuntimeState;
  /** Reuse an open browser (multi-state scans); it is not closed. */
  browser?: Browser;
}

interface AxeNode {
  target: unknown[];
  html: string;
  failureSummary?: string;
  impact?: string;
}
interface AxeViolation {
  id: string;
  impact?: string;
  tags: string[];
  help: string;
  description: string;
  helpUrl: string;
  nodes: AxeNode[];
}

function tagsFor(level: "A" | "AA" | "AAA", bestPractice: boolean): string[] {
  const tags = ["wcag2a", "wcag21a", "wcag22a"];
  if (level !== "A") tags.push("wcag2aa", "wcag21aa", "wcag22aa");
  if (level === "AAA") tags.push("wcag2aaa", "wcag21aaa", "wcag22aaa");
  if (bestPractice) tags.push("best-practice");
  return tags;
}

async function runAxe(page: Page, options: object, context?: object): Promise<AxeViolation[]> {
  return (await page.evaluate(
    async ([ctx, opts]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const a = (window as any).axe;
      const res = await a.run(ctx ?? document, opts);
      return res.violations;
    },
    [context ?? null, options] as const,
  )) as AxeViolation[];
}

function targetToSelector(target: unknown[]): string {
  return target.map((t) => (Array.isArray(t) ? t.join(" >>> ") : String(t))).join(" >>> iframe ");
}

export async function scanUrl(url: string, opts: RuntimeOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const browser = opts.browser ?? (await launchBrowser(opts));
  const state = opts.state;
  try {
    const context = await browser.newContext({
      viewport: state?.viewport ?? opts.viewport ?? { width: 1280, height: 800 },
      colorScheme: state?.colorScheme ?? opts.colorScheme,
      reducedMotion: state?.reducedMotion,
      storageState: opts.storageState,
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs ?? 30_000 });
    if (opts.waitFor) {
      const waiting = page.waitForSelector(opts.waitFor, { timeout: opts.timeoutMs ?? 30_000 });
      if (opts.waitForOptional) await waiting.catch(() => {});
      else await waiting;
    }
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    if (state?.steps?.length) await runSteps(page, state.steps, Math.min(opts.timeoutMs ?? 10_000, 10_000));

    // evaluate() is not subject to the page's CSP, unlike addScriptTag.
    await page.evaluate(axe.source);
    const runOptions = {
      runOnly: { type: "tag", values: tagsFor(opts.level ?? "AA", !!opts.bestPractice) },
      resultTypes: ["violations"],
    };
    const axeContext = opts.exclude?.length ? { include: [["html"]], exclude: opts.exclude.map((s) => [s]) } : undefined;
    const violations = await runAxe(page, runOptions, axeContext);

    let discarded = 0;
    const findings: Finding[] = [];
    for (const v of violations) {
      let nodes = v.nodes;
      if (opts.verify !== false) {
        // Verification pass: re-run only this rule, only on the flagged nodes, after the page settles.
        await page.waitForTimeout(150);
        const recheck = await runAxe(
          page,
          { runOnly: { type: "rule", values: [v.id] }, resultTypes: ["violations"] },
          { include: v.nodes.map((n) => n.target) },
        ).catch(() => null);
        if (recheck) {
          const confirmed = new Set((recheck[0]?.nodes ?? []).map((n) => JSON.stringify(n.target)));
          const kept = nodes.filter((n) => confirmed.has(JSON.stringify(n.target)));
          discarded += nodes.length - kept.length;
          nodes = kept;
        }
      }
      const wcag = criteriaFromAxeTags(v.tags);
      for (const node of nodes) {
        const selector = targetToSelector(node.target);
        findings.push({
          id: fingerprint(`axe/${v.id}`, url, selector),
          ruleId: `axe/${v.id}`,
          source: "runtime",
          title: v.help,
          wcag,
          level: levelFor(wcag),
          severity: normalizeImpact(node.impact ?? v.impact),
          confidence: "high",
          location: { url, selector },
          evidence: truncate(node.html),
          message: summarize(node.failureSummary) || v.description,
          fix: AXE_FIXES[v.id] ?? `${v.help}. See ${v.helpUrl}`,
          helpUrl: v.helpUrl,
          verified: opts.verify !== false,
        });
      }
    }

    if (opts.keyboard !== false) {
      // In a state reached by clicking (an open modal), a click to reset focus could close it again.
      findings.push(...(await keyboardAudit(page, url, { noMouse: !!state?.steps?.length })));
    }

    // The same element in another state is a different finding (for verify and baselines).
    if (state) {
      for (const f of findings) {
        f.id = fingerprint(f.id, "state", state.name);
        f.location.state = state.name;
      }
    }

    await context.close();
    return {
      tool: TOOL,
      target: url,
      kind: "runtime",
      startedAt: new Date(started).toISOString(),
      durationMs: Date.now() - started,
      findings,
      discarded,
      ...(state ? { state } : {}),
    };
  } finally {
    if (!opts.browser) await browser.close();
  }
}

function normalizeImpact(i?: string): Severity {
  return i === "critical" || i === "serious" || i === "moderate" || i === "minor" ? i : "moderate";
}

function summarize(s?: string): string {
  if (!s) return "";
  return s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^Fix (any|all) of the following:?$/i.test(l))
    .join(" ");
}
