import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { RuntimeOptions } from "./runtime/scan-url.js";
import { type StaticOptions, scanStatic } from "./static/analyze.js";
import type { Confidence, Finding, ScanResult } from "./types.js";

export interface ScanOptions extends StaticOptions, RuntimeOptions {
  /** Force runtime (browser) scanning of a local .html file. */
  runtime?: boolean;
  minConfidence?: Confidence;
}

const CONF_RANK: Record<Confidence, number> = { low: 1, medium: 2, high: 3 };

export function isUrl(target: string): boolean {
  return /^(https?|file):\/\//i.test(target);
}

/** Scan a path (static) or URL (runtime). Local .html files can be scanned in a browser with `runtime: true`. */
export async function scan(target: string, opts: ScanOptions = {}): Promise<ScanResult> {
  let result: ScanResult;
  // Loaded lazily so static scans never touch axe-core or playwright-core.
  const scanUrl = async (url: string, o: ScanOptions) => (await import("./runtime/scan-url.js")).scanUrl(url, o);
  if (isUrl(target)) {
    result = await scanUrl(target, opts);
  } else if (opts.runtime) {
    const abs = path.resolve(opts.cwd ?? process.cwd(), target);
    if (!existsSync(abs)) throw new Error(`No such file: ${target}`);
    result = await scanUrl(pathToFileURL(abs).href, opts);
    result.target = target;
  } else {
    const abs = path.resolve(opts.cwd ?? process.cwd(), target);
    if (!existsSync(abs)) throw new Error(`No such file or directory: ${target}`);
    result = await scanStatic(target, opts);
  }
  if (opts.minConfidence) result.findings = filterConfidence(result.findings, opts.minConfidence);
  return result;
}

export function filterConfidence(findings: Finding[], min: Confidence): Finding[] {
  return findings.filter((f) => CONF_RANK[f.confidence] >= CONF_RANK[min]);
}

export interface VerifyResult {
  resolved: Finding[];
  remaining: Finding[];
  introduced: Finding[];
}

/**
 * Re-run the scans recorded in a previous JSON report and diff by finding id.
 * Used in the fix phase: `resolved` proves a fix worked, `introduced` catches regressions.
 */
export async function verifyReport(report: { scans: ScanResult[] }, opts: ScanOptions = {}): Promise<VerifyResult> {
  const out: VerifyResult = { resolved: [], remaining: [], introduced: [] };
  for (const prev of report.scans) {
    const runtime = prev.kind === "runtime";
    const fresh = prev.story
      ? (await (await import("./runtime/storybook.js")).scanStorybook(prev.story.source, { ...opts, storyIds: [prev.story.id] }))[0]!
      : await scan(prev.target, { ...opts, runtime: runtime && !isUrl(prev.target) ? true : opts.runtime });
    const now = new Map(fresh.findings.map((f) => [f.id, f]));
    const before = new Set(prev.findings.map((f) => f.id));
    for (const f of prev.findings) (now.has(f.id) ? out.remaining : out.resolved).push(f);
    for (const f of fresh.findings) if (!before.has(f.id)) out.introduced.push(f);
  }
  return out;
}
