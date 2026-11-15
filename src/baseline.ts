import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding, ScanResult } from "./types.js";
import { TOOL } from "./version.js";

/** Default location of the baseline file, relative to the working directory. */
export const DEFAULT_BASELINE = ".wcag-audit/baseline.json";

export interface BaselineEntry {
  /** Stable finding fingerprint (the `id` of a finding). This is the only field used for matching. */
  id: string;
  ruleId: string;
  /** File (static) or URL (runtime), so a human can read the baseline. */
  where: string;
}

export interface Baseline {
  version: 1;
  tool: { name: string; version: string };
  createdAt: string;
  findings: BaselineEntry[];
}

export interface BaselineResult {
  /** Findings in the baseline that were found again (hidden from the report). */
  known: number;
  /** Baseline entries that no longer match any finding (fixed, or the code moved to another file). */
  stale: number;
}

export function createBaseline(results: ScanResult[]): Baseline {
  const seen = new Set<string>();
  const findings: BaselineEntry[] = [];
  for (const f of results.flatMap((r) => r.findings)) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    findings.push({ id: f.id, ruleId: f.ruleId, where: f.location.file ?? f.location.url ?? "" });
  }
  findings.sort((a, b) => a.where.localeCompare(b.where) || a.ruleId.localeCompare(b.ruleId) || a.id.localeCompare(b.id));
  return { version: 1, tool: TOOL, createdAt: new Date().toISOString(), findings };
}

export async function writeBaseline(file: string, results: ScanResult[]): Promise<Baseline> {
  const baseline = createBaseline(results);
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(baseline, null, 2) + "\n");
  return baseline;
}

/**
 * Read a baseline. Accepts a file written by `--write-baseline`, or a `--json` report
 * (every finding in it counts as known), so an existing report can serve as the baseline.
 */
export async function readBaseline(file: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    throw new Error(`Baseline file not found: ${file} (create it with --write-baseline)`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`Baseline file is not valid JSON: ${file}`);
  }
  const d = data as { findings?: Array<{ id?: unknown }>; scans?: Array<{ findings?: Array<{ id?: unknown }> }> };
  const entries = Array.isArray(d.findings) ? d.findings : Array.isArray(d.scans) ? d.scans.flatMap((s) => s.findings ?? []) : undefined;
  if (!entries) throw new Error(`${file} is not a ${TOOL.name} baseline or --json report`);
  return new Set(entries.map((e) => e.id).filter((id): id is string => typeof id === "string"));
}

/** Remove known findings from each result (in place) and count them. */
export function applyBaseline(results: ScanResult[], known: Set<string>): BaselineResult {
  const matched = new Set<string>();
  for (const r of results) {
    const fresh: Finding[] = [];
    let hidden = 0;
    for (const f of r.findings) {
      if (known.has(f.id)) {
        matched.add(f.id);
        hidden++;
      } else fresh.push(f);
    }
    r.findings = fresh;
    r.baselined = hidden;
  }
  return { known: [...known].filter((id) => matched.has(id)).length, stale: [...known].filter((id) => !matched.has(id)).length };
}
