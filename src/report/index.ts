import { pathToFileURL } from "node:url";
import { rules } from "../static/rules.js";
import { type Finding, type ScanResult, SEVERITY_ORDER, type Severity } from "../types.js";
import { WCAG } from "../wcag.js";

const useColor = () => {
  const env = process.env;
  if (env.NO_COLOR) return false;
  if (env.FORCE_COLOR !== undefined) return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  return Boolean(process.stdout.isTTY);
};
const c = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const SEV_COLOR: Record<Severity, string> = { critical: "1;31", serious: "31", moderate: "33", minor: "36" };

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] ||
      locKey(a).localeCompare(locKey(b)) ||
      (a.location.line ?? 0) - (b.location.line ?? 0),
  );
}

function locKey(f: Finding): string {
  return f.location.file ?? f.location.url ?? "";
}

export function where(f: Finding): string {
  const l = f.location;
  if (l.file) return `${l.file}:${l.line ?? 1}:${l.column ?? 1}`;
  return `${l.url ?? ""} ${l.selector ? `[${l.selector}]` : ""}${l.state ? ` (state: ${l.state})` : ""}`.trim();
}

export function counts(findings: Finding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const f of findings) out[f.severity]++;
  return out;
}

export function formatText(results: ScanResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const head =
      r.kind === "static"
        ? `Static scan of ${r.target} (${r.filesScanned ?? 0} file${r.filesScanned === 1 ? "" : "s"})`
        : r.story
          ? `Story ${r.story.title} / ${r.story.name} (${r.target})`
          : `Runtime scan of ${r.target}${r.state ? ` (state: ${r.state.name})` : ""}`;
    lines.push(c("1", head));
    if (!r.findings.length) {
      lines.push(c("32", r.baselined ? "  ✓ No new accessibility issues (all findings are in the baseline)." : "  ✓ No accessibility issues found by automated checks."));
      lines.push("");
      continue;
    }
    for (const f of sortFindings(r.findings)) {
      const sev = c(SEV_COLOR[f.severity], f.severity.toUpperCase().padEnd(8));
      const crit = f.wcag.length ? f.wcag.map((w) => `${w} ${WCAG[w]?.title ?? ""}`.trim()).join(", ") : "best practice";
      lines.push(`  ${sev} ${c("1", f.ruleId)}  ${c("2", `WCAG ${crit} (${f.level})`)}`);
      lines.push(`           ${c("4", where(f))}`);
      lines.push(`           ${f.message}`);
      lines.push(`           ${c("2", "evidence:")} ${f.evidence}`);
      lines.push(`           ${c("32", "fix:")} ${f.fix}`);
      if (f.confidence !== "high") lines.push(`           ${c("2", `confidence: ${f.confidence} — verify before fixing`)}`);
      lines.push("");
    }
  }
  const all = results.flatMap((r) => r.findings);
  const n = counts(all);
  const discarded = results.reduce((s, r) => s + r.discarded, 0);
  const baselined = results.reduce((s, r) => s + (r.baselined ?? 0), 0);
  lines.push(
    `${c(all.length ? "1" : "1;32", `${all.length} issue${all.length === 1 ? "" : "s"}`)}: ` +
      (Object.keys(n) as Severity[]).map((s) => c(n[s] ? SEV_COLOR[s] : "2", `${n[s]} ${s}`)).join(", ") +
      (discarded ? c("2", ` (${discarded} unverified result${discarded === 1 ? "" : "s"} discarded)`) : "") +
      (baselined ? c("2", ` (${baselined} known issue${baselined === 1 ? "" : "s"} in the baseline not shown)`) : ""),
  );
  lines.push(c("2", "Automated checks catch roughly 30–50% of WCAG issues. Manual and assistive-technology testing is still required."));
  return lines.join("\n");
}

export function formatJson(results: ScanResult[]): string {
  const all = results.flatMap((r) => r.findings);
  return JSON.stringify(
    {
      version: 1,
      tool: results[0]?.tool,
      summary: {
        total: all.length,
        ...counts(all),
        discarded: results.reduce((s, r) => s + r.discarded, 0),
        ...(results.some((r) => r.baselined !== undefined) ? { baselined: results.reduce((s, r) => s + (r.baselined ?? 0), 0) } : {}),
      },
      scans: results.map((r) => ({ ...r, findings: sortFindings(r.findings) })),
    },
    null,
    2,
  );
}

const SARIF_LEVEL: Record<Severity, "error" | "warning" | "note"> = {
  critical: "error",
  serious: "error",
  moderate: "warning",
  minor: "note",
};

/** SARIF wants URIs: repo-relative paths resolve against %SRCROOT%, absolute paths become file:// URIs. */
function artifactFor(file: string): { uri: string; uriBaseId?: string } {
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) return { uri: pathToFileURL(file).href };
  return { uri: file.split("/").map(encodeURIComponent).join("/"), uriBaseId: "%SRCROOT%" };
}

export function formatSarif(results: ScanResult[]): string {
  const all = results.flatMap((r) => r.findings);
  const ruleIds = [...new Set(all.map((f) => f.ruleId))].sort();
  const staticMeta = new Map(rules.map((r) => [r.meta.id, r.meta]));
  const sarifRules = ruleIds.map((id) => {
    const sample = all.find((f) => f.ruleId === id)!;
    const meta = staticMeta.get(id);
    return {
      id,
      name: id.replace(/[^a-zA-Z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : "")),
      shortDescription: { text: meta?.title ?? sample.title },
      fullDescription: { text: meta?.description ?? sample.title },
      helpUri: sample.helpUrl,
      help: { text: sample.fix, markdown: `**Fix:** ${sample.fix}\n\nWCAG ${sample.wcag.join(", ") || "best practice"}` },
      defaultConfiguration: { level: SARIF_LEVEL[meta?.severity ?? sample.severity] },
      properties: {
        tags: ["accessibility", "a11y", ...sample.wcag.map((w) => `wcag-${w}`), `wcag-level-${sample.level}`],
        precision: sample.confidence === "high" ? "high" : "medium",
        "problem.severity": SARIF_LEVEL[sample.severity] === "note" ? "recommendation" : SARIF_LEVEL[sample.severity],
      },
    };
  });
  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: results[0]?.tool.name ?? "wcag-audit-skill",
            version: results[0]?.tool.version,
            rules: sarifRules,
          },
        },
        results: sortFindings(all).map((f) => ({
          ruleId: f.ruleId,
          ruleIndex: ruleIds.indexOf(f.ruleId),
          level: SARIF_LEVEL[f.severity],
          message: { text: `${f.message} Fix: ${f.fix}` },
          locations: [
            f.location.file
              ? {
                  physicalLocation: {
                    artifactLocation: artifactFor(f.location.file),
                    region: { startLine: f.location.line ?? 1, startColumn: f.location.column ?? 1, snippet: { text: f.evidence } },
                  },
                }
              : {
                  physicalLocation: { artifactLocation: { uri: f.location.url } },
                  logicalLocations: [{ fullyQualifiedName: f.location.state ? `${f.location.selector} (state: ${f.location.state})` : f.location.selector, kind: "element" }],
                },
          ],
          partialFingerprints: { "wcagAuditFinding/v1": f.id },
          properties: { wcag: f.wcag, severity: f.severity, confidence: f.confidence, verified: f.verified ?? f.confidence === "high" },
        })),
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
