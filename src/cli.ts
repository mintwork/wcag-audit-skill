#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { DEFAULT_BASELINE, applyBaseline, readBaseline, writeBaseline } from "./baseline.js";
import { FIXABLE_RULES, planFixes, unifiedDiff, writeFixes } from "./fix.js";
import { type ScanJob, jobsFromConfig, loadRuntimeConfig } from "./runtime/states.js";
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
  --baseline <file>      report (and fail on) only findings that are not in this baseline file,
                         e.g. ${DEFAULT_BASELINE}; a --json report also works as a baseline
  --write-baseline       record all current findings in the --baseline file (default
                         ${DEFAULT_BASELINE}) and exit 0

Fixing (static targets)
  --fix                  fix mechanical findings in place: html-lang (repair "en_US", "English"),
                         meta-viewport-zoom (drop user-scalable=no / maximum-scale), aria-attr-valid
                         typos (aria-lable → aria-label). The diff is always printed first.
  --dry-run              print the diff of --fix without writing anything (implies --fix)
  --lang <code>          with --fix: add lang="<code>" to <html> elements that have none (never guessed)

Runtime
  --level <A|AA|AAA>     WCAG level for axe-core (default: AA)
  --best-practice        include axe best-practice rules
  --no-keyboard          skip Tab traversal (keyboard trap / focus visible)
  --no-verify            skip the verification re-run
  --wait-for <selector>  wait for an element before scanning (SPAs)
  --config <file>        scan the pages and states in a JSON config (open a modal, submit an empty
                         form, dark mode, 320px); see README "Runtime states"
  --storage-state <file> Playwright storage state (cookies, localStorage) for authenticated pages
  --color-scheme <s>     light | dark (prefers-color-scheme)
  --viewport <WxH>       viewport size, e.g. 320x640 (default 1280x800)
  --storybook <url|dir>  scan every story of a Storybook (running URL or static build directory)
  --stories <patterns>   with --storybook: only stories whose id or title contains one of these
                         comma-separated substrings
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
      baseline: { type: "string" },
      "write-baseline": { type: "boolean" },
      level: { type: "string" },
      "best-practice": { type: "boolean" },
      "no-keyboard": { type: "boolean" },
      "no-verify": { type: "boolean" },
      runtime: { type: "boolean" },
      fix: { type: "boolean" },
      "dry-run": { type: "boolean" },
      lang: { type: "string" },
      "wait-for": { type: "string" },
      config: { type: "string" },
      "storage-state": { type: "string" },
      "color-scheme": { type: "string" },
      viewport: { type: "string" },
      storybook: { type: "string" },
      stories: { type: "string" },
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

  const colorScheme = values["color-scheme"] as "light" | "dark" | undefined;
  if (colorScheme && colorScheme !== "light" && colorScheme !== "dark") return usage("--color-scheme must be light or dark");
  let viewport: { width: number; height: number } | undefined;
  if (values.viewport) {
    const m = /^(\d+)x(\d+)$/.exec(values.viewport);
    if (!m) return usage("--viewport must look like 320x640");
    viewport = { width: Number(m[1]), height: Number(m[2]) };
  }

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
    colorScheme,
    viewport,
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
  const config = values.config ? await loadRuntimeConfig(values.config) : undefined;
  if (!targets.length && !config && !values.storybook) return usage("scan needs at least one <path|url> (or --config / --storybook)");
  const storageState = values["storage-state"] ?? config?.storageState;
  if (storageState && !existsSync(storageState)) return usage(`storage state file not found: ${storageState}`);
  opts.storageState = storageState;

  const baselineFile = values.baseline || DEFAULT_BASELINE;
  // Read the baseline before scanning, so a missing file fails fast.
  const known = values.baseline !== undefined && !values["write-baseline"] ? await readBaseline(baselineFile) : undefined;

  let results: ScanResult[] = [];
  for (const t of targets) results.push(await scan(t, opts));
  if (config) results.push(...(await scanJobs(jobsFromConfig(config), opts)));
  if (values.storybook) {
    const { scanStorybook } = await import("./runtime/storybook.js");
    const progress = process.stderr.isTTY ? (i: number, n: number) => process.stderr.write(`\r${TOOL.name}: story ${i}/${n}${i === n ? "\n" : ""}`) : undefined;
    results.push(...(await scanStorybook(values.storybook, { ...opts, stories: values.stories, onStory: progress })));
  }
  if (values.source) {
    const { addSourceHints } = await import("./runtime/source-hints.js");
    const runtime = results.filter((r) => r.kind === "runtime").reduce((n, r) => n + r.findings.length, 0);
    if (runtime) {
      const n = await addSourceHints(results, values.source, { ignore: opts.ignore });
      console.error(`${TOOL.name}: source hints for ${n} of ${runtime} runtime finding${runtime === 1 ? "" : "s"} (verify before editing)`);
    }
  }

  if (values.fix || values["dry-run"]) {
    const dryRun = !!values["dry-run"];
    const files = results.filter((r) => r.kind === "static").flatMap((r) => r.findings.filter((f) => FIXABLE_RULES.includes(f.ruleId)).map((f) => f.location.file!));
    const plan = await planFixes(files, { lang: values.lang });
    const diff = plan.map((f) => unifiedDiff(f.file, f.before, f.after)).filter(Boolean).join("\n");
    // The diff goes to stdout, unless stdout carries the JSON / SARIF report.
    const machineStdout = (values.json || values.sarif) && !values.output;
    if (diff) (machineStdout ? process.stderr : process.stdout).write(diff + "\n\n");
    for (const f of plan) for (const s of f.skipped) console.error(`${TOOL.name}: not fixed: ${s.ruleId} at ${f.file}:${s.line} (${s.reason})`);
    const fixed = plan.reduce((n, f) => n + f.applied.length, 0);
    const changedFiles = plan.filter((f) => f.after !== f.before).length;
    if (dryRun) {
      console.error(`${TOOL.name}: dry run: ${fixed} finding${fixed === 1 ? "" : "s"} fixable in ${changedFiles} file${changedFiles === 1 ? "" : "s"}; nothing written.`);
    } else {
      await writeFixes(plan);
      console.error(`${TOOL.name}: fixed ${fixed} finding${fixed === 1 ? "" : "s"} in ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`);
      // Report what is left.
      // Re-scan only the static results; runtime results (URLs, --config states) are unaffected.
      if (changedFiles) results = await Promise.all(results.map((r) => (r.kind === "static" ? scan(r.target, opts) : r)));
    }
  }

  if (values["write-baseline"]) {
    const b = await writeBaseline(baselineFile, results);
    console.error(`${TOOL.name}: wrote ${baselineFile} (${b.findings.length} known finding${b.findings.length === 1 ? "" : "s"}). Commit it and scan with --baseline ${baselineFile}.`);
    return 0;
  }
  if (known) {
    const b = applyBaseline(results, known);
    if (b.stale) console.error(`${TOOL.name}: ${b.stale} baseline entr${b.stale === 1 ? "y" : "ies"} no longer found (fixed or moved); run with --write-baseline to prune.`);
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

/** Config pages × states, in one browser. */
async function scanJobs(jobs: ScanJob[], opts: ScanOptions): Promise<ScanResult[]> {
  const { launchBrowser } = await import("./runtime/browser.js");
  const browser = await launchBrowser(opts);
  const out: ScanResult[] = [];
  try {
    for (const job of jobs) {
      const label = job.state ? `${job.url} (state: ${job.state.name})` : job.url;
      try {
        out.push(await scan(job.url, { ...opts, waitFor: job.waitFor ?? opts.waitFor, state: job.state, browser }));
      } catch (e) {
        throw new Error(`${label}: ${(e as Error).message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return out;
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
