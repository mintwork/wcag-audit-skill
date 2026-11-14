#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { counts, formatJson, formatSarif, formatText, where } from "./report/index.js";
import { type ScanOptions, scan, verifyReport } from "./scan.js";
import { rules } from "./static/rules.js";
import { type Confidence, SEVERITY_ORDER, type ScanResult, type Severity } from "./types.js";
import { TOOL } from "./version.js";
import { WCAG } from "./wcag.js";

const HELP = `${TOOL.name} ${TOOL.version} — WCAG 2.2 accessibility audit for source code and live pages

Usage
  ${TOOL.name} scan <path|url> [more targets…] [options]
  ${TOOL.name} verify <report.json> [options]     re-check a previous --json report
  ${TOOL.name} rules [--json]                     list static rules and WCAG mapping

Targets
  ./src, app.tsx, index.html   static analysis of HTML / JSX / TSX / Vue / Svelte / Astro
  http://localhost:3000        runtime scan in a real browser (axe-core + keyboard checks)
  ./page.html --runtime        open a local HTML file in the browser instead

Output
  --json                 machine-readable findings (default: human-readable)
  --sarif                SARIF 2.1.0 for GitHub code scanning
  -o, --output <file>    write report to a file instead of stdout

Filtering & CI
  --fail-on <sev>        exit 1 if any finding is >= critical|serious|moderate|minor (default: minor), or "none"
  --min-confidence <c>   drop findings below high|medium|low (default: low)
  --rules <ids>          comma-separated static rule ids to run
  --ignore <names>       comma-separated directory/file names to skip

Runtime
  --level <A|AA|AAA>     WCAG level for axe-core (default: AA)
  --best-practice        include axe best-practice rules
  --no-keyboard          skip Tab traversal (keyboard trap / focus visible)
  --no-verify            skip the verification re-run
  --wait-for <selector>  wait for an element before scanning (SPAs)
  --source <dir>         map runtime findings to likely source files (best effort; reported as a
                         hint) by searching <dir> for test ids, ids, labels, class names and text
  --browser <channel>    chromium | chrome | msedge (default: auto-detect)
  --headed               show the browser window
  --timeout <ms>         navigation timeout (default: 30000)

  -h, --help             show help
  -v, --version          show version
`;

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      sarif: { type: "boolean" },
      output: { type: "string", short: "o" },
      "fail-on": { type: "string" },
      "min-confidence": { type: "string" },
      rules: { type: "string" },
      ignore: { type: "string" },
      level: { type: "string" },
      "best-practice": { type: "boolean" },
      "no-keyboard": { type: "boolean" },
      "no-verify": { type: "boolean" },
      runtime: { type: "boolean" },
      "wait-for": { type: "string" },
      source: { type: "string" },
      browser: { type: "string" },
      headed: { type: "boolean" },
      timeout: { type: "string" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.version) {
    console.log(TOOL.version);
    return 0;
  }
  const [command, ...targets] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return values.help ? 0 : 2;
  }

  const level = (values.level?.toUpperCase() ?? "AA") as "A" | "AA" | "AAA";
  if (!["A", "AA", "AAA"].includes(level)) return usage(`--level must be A, AA or AAA`);
  const minConfidence = values["min-confidence"] as Confidence | undefined;
  if (minConfidence && !["high", "medium", "low"].includes(minConfidence)) return usage("--min-confidence must be high, medium or low");
  const failOn = (values["fail-on"] ?? "minor") as Severity | "none";
  if (failOn !== "none" && !(failOn in SEVERITY_ORDER)) return usage("--fail-on must be critical, serious, moderate, minor or none");

  const opts: ScanOptions = {
    level,
    minConfidence,
    rules: values.rules?.split(",").map((s) => s.trim()).filter(Boolean),
    ignore: values.ignore?.split(",").map((s) => s.trim()).filter(Boolean),
    bestPractice: values["best-practice"],
    keyboard: !values["no-keyboard"],
    verify: !values["no-verify"],
    runtime: values.runtime,
    waitFor: values["wait-for"],
    channel: values.browser,
    headed: values.headed,
    timeoutMs: values.timeout ? Number(values.timeout) : undefined,
  };

  if (command === "rules") {
    if (values.json) console.log(JSON.stringify(rules.map((r) => r.meta), null, 2));
    else
      for (const r of rules)
        console.log(`${r.meta.id.padEnd(26)} ${r.meta.severity.padEnd(9)} WCAG ${r.meta.wcag.map((w) => `${w} ${WCAG[w]?.title}`).join(", ")}`);
    return 0;
  }

  if (command === "verify") {
    if (targets.length !== 1) return usage("verify takes exactly one report.json");
    const report = JSON.parse(await readFile(targets[0]!, "utf8")) as { scans: ScanResult[] };
    if (!Array.isArray(report.scans)) return usage(`${targets[0]} is not a ${TOOL.name} --json report`);
    const res = await verifyReport(report, opts);
    if (values.json) {
      await emit(JSON.stringify(res, null, 2), values.output);
    } else {
      const lines = [
        `Resolved:   ${res.resolved.length}`,
        ...res.resolved.map((f) => `  ✓ ${f.ruleId}  ${where(f)}`),
        `Remaining:  ${res.remaining.length}`,
        ...res.remaining.map((f) => `  ✗ ${f.ruleId}  ${where(f)}`),
        `Introduced: ${res.introduced.length}`,
        ...res.introduced.map((f) => `  + ${f.ruleId}  ${where(f)}  ${f.message}`),
      ];
      await emit(lines.join("\n"), values.output);
    }
    return res.remaining.length || res.introduced.length ? 1 : 0;
  }

  if (command !== "scan") return usage(`Unknown command "${command}"`);
  if (!targets.length) return usage("scan needs at least one <path|url>");

  const results: ScanResult[] = [];
  for (const t of targets) results.push(await scan(t, opts));
  if (values.source) {
    const { addSourceHints } = await import("./runtime/source-hints.js");
    const runtime = results.filter((r) => r.kind === "runtime").reduce((n, r) => n + r.findings.length, 0);
    if (runtime) {
      const n = await addSourceHints(results, values.source, { ignore: opts.ignore });
      console.error(`${TOOL.name}: source hints for ${n} of ${runtime} runtime finding${runtime === 1 ? "" : "s"} (verify before editing)`);
    }
  }

  const out = values.sarif ? formatSarif(results) : values.json ? formatJson(results) : formatText(results);
  await emit(out, values.output);
  if (values.output) {
    const n = counts(results.flatMap((r) => r.findings));
    console.error(`${TOOL.name}: wrote ${values.output} (${n.critical} critical, ${n.serious} serious, ${n.moderate} moderate, ${n.minor} minor)`);
  }

  if (failOn === "none") return 0;
  const threshold = SEVERITY_ORDER[failOn];
  return results.some((r) => r.findings.some((f) => SEVERITY_ORDER[f.severity] >= threshold)) ? 1 : 0;
}

async function emit(text: string, file?: string) {
  if (file) await writeFile(file, text + "\n");
  else process.stdout.write(text + "\n");
}

function usage(msg: string): number {
  console.error(`${TOOL.name}: ${msg}\nRun "${TOOL.name} --help" for usage.`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: Error) => {
    console.error(`${TOOL.name}: ${err.message}`);
    process.exitCode = 2;
  },
);
