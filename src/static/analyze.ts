import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Finding, ScanResult } from "../types.js";
import { TOOL } from "../version.js";
import { levelFor, understandingUrl } from "../wcag.js";
import { type ElementNode, type Framework, type ParsedDocument, truncate } from "./ast.js";
import { walk } from "./helpers.js";
import { parseMarkup } from "./parse-html.js";
import { parseJsx } from "./parse-jsx.js";
import { parseMdx } from "./parse-mdx.js";
import { type Report, type RuleContext, rules } from "./rules.js";

export const SUPPORTED_EXTENSIONS: Record<string, Framework> = {
  ".html": "html",
  ".htm": "html",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".mdx": "mdx",
  ".jsx": "jsx",
  ".tsx": "jsx",
  ".js": "jsx",
  ".mjs": "jsx",
};

const DEFAULT_IGNORES = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", "coverage", "vendor", ".turbo", ".cache", "__tests__", "__mocks__", "tests", "e2e", "cypress", "storybook-static", "playwright-report", "test", "fixtures", "__fixtures__", "__snapshots__", "venv", "site-packages", "bower_components"]);

export interface StaticOptions {
  /** Directory/file names to skip, in addition to the defaults. */
  ignore?: string[];
  /** Only run these rule ids. */
  rules?: string[];
  cwd?: string;
}

export function parseFile(file: string, source: string): ParsedDocument | undefined {
  const fw = SUPPORTED_EXTENSIONS[path.extname(file).toLowerCase()];
  if (!fw) return undefined;
  if (fw === "jsx") {
    // Skip plain JS that contains no JSX at all (cheap pre-check, big speedup on large repos).
    if (!/<[A-Za-z>]/.test(source)) return undefined;
    return parseJsx(file, source);
  }
  if (fw === "mdx") return parseMdx(file, source);
  return parseMarkup(file, source, fw);
}

/** Analyze an in-memory source string. `file` determines the parser (by extension). */
export function analyzeSource(file: string, source: string, opts: StaticOptions = {}): Finding[] {
  const doc = parseFile(file, source);
  if (!doc) return [];
  if (/wcag-audit-ignore-file/.test(source)) return [];
  const lines = source.split("\n");
  const labelTargets = new Set<string>();
  let hasDynamicLabelTarget = false;
  const all = [...walk(doc.root)];
  for (const el of all) {
    if (el.tag !== "label") continue;
    const f = el.attrs.get("for");
    if (!f) continue;
    if (f.dynamic) hasDynamicLabelTarget = true;
    else if (f.value) labelTargets.add(f.value);
  }

  const out: Finding[] = [];
  const active = opts.rules?.length ? rules.filter((r) => opts.rules!.includes(r.meta.id)) : rules;
  for (const rule of active) {
    const ctx: RuleContext = {
      doc,
      labelTargets,
      hasDynamicLabelTarget,
      report: (r: Report) => {
        if (isSuppressed(lines, r.el, rule.meta.id)) return;
        out.push(toFinding(doc, rule.meta, r));
      },
    };
    const handlers = rule.create(ctx);
    if (handlers.element) for (const el of all) handlers.element(el);
    handlers.done?.();
  }
  out.sort((a, b) => (a.location.line ?? 0) - (b.location.line ?? 0) || a.ruleId.localeCompare(b.ruleId));
  return dedupeIds(out);
}

function isSuppressed(lines: string[], el: ElementNode, ruleId: string): boolean {
  for (const ln of [el.line - 1, el.line - 2]) {
    const text = lines[ln];
    if (text === undefined) continue;
    const m = /wcag-audit-ignore(?!-file)(?:-next-line)?\b([^\n]*)/.exec(text);
    if (!m) continue;
    const ids = m[1]!.replace(/(-->|\*\/|\}|\*)/g, " ").trim().split(/[\s,]+/).filter((s) => /^[a-z][a-z-]+$/.test(s));
    if (!ids.length || ids.includes(ruleId)) return true;
  }
  return false;
}

function toFinding(doc: ParsedDocument, meta: (typeof rules)[number]["meta"], r: Report): Finding {
  const evidence = truncate(r.el.openTag || `<${r.el.tag}>`);
  const file = doc.file;
  return {
    id: fingerprint(meta.id, file, evidence),
    ruleId: meta.id,
    source: "static",
    title: meta.title,
    wcag: meta.wcag,
    level: levelFor(meta.wcag),
    severity: r.severity ?? meta.severity,
    confidence: r.confidence ?? "high",
    location: { file, line: r.el.line, column: r.el.column },
    evidence,
    message: r.message,
    fix: r.fix,
    helpUrl: understandingUrl(meta.wcag[0]!),
  };
}

export function fingerprint(...parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

function dedupeIds(findings: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    if (n > 0) f.id = `${f.id}-${n + 1}`;
  }
  return findings;
}

export async function collectFiles(target: string, ignore: string[] = []): Promise<string[]> {
  const ignores = new Set([...DEFAULT_IGNORES, ...ignore]);
  const st = await stat(target);
  if (st.isFile()) return [target];
  const out: string[] = [];
  const recurse = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (ignores.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".") && e.name !== ".") continue;
        await recurse(full);
      } else if (e.isFile() && SUPPORTED_EXTENSIONS[path.extname(e.name).toLowerCase()] && !/\.(test|spec|stories)\.[jt]sx?$/.test(e.name) && !e.name.endsWith(".min.js")) {
        out.push(full);
      }
    }
  };
  await recurse(target);
  return out.sort();
}

export async function scanStatic(target: string, opts: StaticOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const files = await collectFiles(path.resolve(cwd, target), opts.ignore);
  const findings: Finding[] = [];
  for (const abs of files) {
    const source = await readFile(abs, "utf8");
    if (source.length > 2_000_000) continue;
    // Outside cwd, a "../../.." path is useless in reports and SARIF; use the absolute path instead.
    const relative = path.relative(cwd, abs);
    const rel = (relative.startsWith("..") || path.isAbsolute(relative) ? abs : relative).split(path.sep).join("/") || path.basename(abs);
    findings.push(...analyzeSource(rel, source, opts));
  }
  return {
    tool: TOOL,
    target,
    kind: "static",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    filesScanned: files.length,
    findings,
    discarded: 0,
  };
}
