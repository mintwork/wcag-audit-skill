import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Finding, ScanResult } from "../types.js";
import { TOOL } from "../version.js";
import { levelFor, understandingUrl } from "../wcag.js";
import { type ElementNode, type Framework, type ParsedDocument, createRoot, truncate } from "./ast.js";
import { outlineIssues, styleBlocks } from "./css.js";
import { walk } from "./helpers.js";
import { parseMarkup } from "./parse-html.js";
import { mayHaveInlineTemplate, parseAngularComponent } from "./parse-angular.js";
import { parseJsx } from "./parse-jsx.js";
import { parseMdx } from "./parse-mdx.js";
import { type ComponentResolver, createResolver } from "./resolve.js";
import { type Report, type ResolvedComponent, type RuleContext, rules } from "./rules.js";

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

/** Stylesheets: checked for focus outlines removed without a replacement (focus-outline-removed). */
export const STYLE_EXTENSIONS: Record<string, "css" | "scss" | "less"> = { ".css": "css", ".scss": "scss", ".less": "less" };
const CSS_RULE = "focus-outline-removed";

const DEFAULT_IGNORES = new Set(["node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", ".output", "coverage", "vendor", ".turbo", ".cache", "__tests__", "__mocks__", "tests", "e2e", "cypress", "storybook-static", "playwright-report", "test", "fixtures", "__fixtures__", "__snapshots__", "venv", "site-packages", "bower_components"]);

export interface StaticOptions {
  /** Directory/file names to skip, in addition to the defaults. */
  ignore?: string[];
  /** Only run these rule ids. */
  rules?: string[];
  cwd?: string;
  /**
   * Finds components imported from other files (labels from an imported <Field>, a thin <Input> wrapper).
   * scanStatic creates one for the project; without it, only components defined in the same file are seen.
   */
  resolver?: ComponentResolver;
}

/** TypeScript files are only scanned for Angular inline templates (`@Component({ template: ... })`). */
const ANGULAR_EXTENSIONS = new Set([".ts", ".mts"]);

export function parseFile(file: string, source: string): ParsedDocument | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ANGULAR_EXTENSIONS.has(ext) && !file.endsWith(".d.ts")) return mayHaveInlineTemplate(source) ? parseAngularComponent(file, source) : undefined;
  const fw = SUPPORTED_EXTENSIONS[ext];
  if (!fw) return undefined;
  if (fw === "jsx") {
    // Skip plain JS that contains no JSX at all (cheap pre-check, big speedup on large repos).
    if (!/<[A-Za-z>]/.test(source)) return undefined;
    return parseJsx(file, source);
  }
  if (fw === "mdx") return parseMdx(file, source);
  return parseMarkup(file, source, fw);
}

/** Parse, reusing (and filling) the resolver's cache of JSX documents. */
function parseShared(file: string, absFile: string, source: string, resolver: ComponentResolver | undefined): ParsedDocument | undefined {
  if (!resolver || SUPPORTED_EXTENSIONS[path.extname(file).toLowerCase()] !== "jsx") return parseFile(file, source);
  const cached = resolver.docs.get(absFile);
  if (cached && cached.source === source) return { ...cached, file };
  const doc = parseFile(file, source);
  if (doc) resolver.docs.set(absFile, { ...doc, file: absFile });
  return doc;
}

/** Analyze an in-memory source string. `file` determines the parser (by extension). */
export function analyzeSource(file: string, source: string, opts: StaticOptions = {}): Finding[] {
  if (/wcag-audit-ignore-file/.test(source)) return [];
  const cssActive = !opts.rules?.length || opts.rules.includes(CSS_RULE);
  const dialect = STYLE_EXTENSIONS[path.extname(file).toLowerCase()];
  if (dialect) return cssActive ? dedupeIds(stylesheetFindings(file, source, [{ css: source, offset: 0, dialect }])) : [];
  const absFile = path.resolve(opts.cwd ?? process.cwd(), file);
  const doc = parseShared(file, absFile, source, opts.resolver);
  if (!doc) return [];
  const lines = source.split("\n");
  const labelTargets = new Set<string>();
  let hasDynamicLabelTarget = false;
  const all = [...walk(doc.root)];
  for (const el of all) {
    // <label for>, and label components that render one: <Label htmlFor> (shadcn, Radix), <FormLabel>, <FieldLabel>.
    if (el.tag !== "label" && !(el.isComponent && /Label$/.test(el.tag))) continue;
    const f = el.attrs.get("for");
    if (!f) continue;
    if (f.dynamic) hasDynamicLabelTarget = true;
    else if (f.value) labelTargets.add(f.value);
  }

  const resolved = new Map<string, ResolvedComponent | undefined>();
  /** A component's definition: in this file, or (with a resolver) in the file it is imported from. */
  const resolveComponent = (el: ElementNode): ResolvedComponent | undefined => {
    if (!el.isComponent) return undefined;
    if (resolved.has(el.tag)) return resolved.get(el.tag);
    let hit: ResolvedComponent | undefined;
    const local = doc.components?.get(el.tag);
    if (local?.length) hit = { trees: local, file: undefined, doc };
    else if (opts.resolver && !el.tag.includes(".")) {
      const imp = doc.modules?.imports.get(el.tag);
      const def = imp && opts.resolver.resolve(absFile, imp);
      if (def) hit = { trees: def.trees, file: path.relative(opts.cwd ?? process.cwd(), def.file).split(path.sep).join("/"), doc: def.doc };
    }
    resolved.set(el.tag, hit);
    return hit;
  };

  const out: Finding[] = [];
  const active = opts.rules?.length ? rules.filter((r) => opts.rules!.includes(r.meta.id)) : rules;
  for (const rule of active) {
    const ctx: RuleContext = {
      doc,
      labelTargets,
      hasDynamicLabelTarget,
      resolveComponent,
      report: (r: Report) => {
        if (isSuppressed(lines, r.el, rule.meta.id)) return;
        out.push(toFinding(doc, rule.meta, r));
      },
    };
    const handlers = rule.create(ctx);
    if (handlers.element) for (const el of all) handlers.element(el);
    handlers.done?.();
  }
  // <style> blocks in HTML / Vue / Svelte / Astro.
  if (cssActive && doc.framework !== "jsx" && /<style\b/i.test(source)) out.push(...stylesheetFindings(file, source, styleBlocks(source)));
  out.sort((a, b) => (a.location.line ?? 0) - (b.location.line ?? 0) || a.ruleId.localeCompare(b.ruleId));
  return dedupeIds(out);
}

function stylesheetFindings(file: string, source: string, blocks: Array<{ css: string; offset: number; dialect: "css" | "scss" | "less" }>): Finding[] {
  const meta = rules.find((r) => r.meta.id === CSS_RULE)!.meta;
  const lines = source.split("\n");
  const doc = { file } as ParsedDocument;
  const out: Finding[] = [];
  for (const b of blocks) {
    for (const issue of outlineIssues(b.css, b.dialect, b.offset, source)) {
      // A synthetic element carries the position and evidence of the CSS rule.
      const el: ElementNode = { ...createRoot(), tag: "#css", line: issue.line, column: issue.column, openTag: issue.evidence };
      if (isSuppressed(lines, el, CSS_RULE)) continue;
      out.push(toFinding(doc, meta, { el, message: issue.message, fix: issue.fix, confidence: issue.confidence }));
    }
  }
  return out;
}

function isSuppressed(lines: string[], el: ElementNode, ruleId: string): boolean {
  for (const ln of [el.line - 1, el.line - 2]) {
    const text = lines[ln];
    if (text === undefined) continue;
    const m = /wcag-audit-ignore(?!-file)(?:-next-line)?\b([^\n]*)/.exec(text);
    if (!m) continue;
    // "wcag-audit-ignore img-alt, link-name: reason": rule ids come before the colon, the reason after.
    const spec = m[1]!.replace(/--!?>|\*\/|\}|\*/g, " ").split(":")[0]!;
    const ids = spec.trim().split(/[\s,]+/).filter((s) => /^[a-z][a-z-]+$/.test(s));
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
      } else if (e.isFile() && (isScannable(e.name) || isAngularCandidate(e.name))) {
        out.push(full);
      }
    }
  };
  await recurse(target);
  return out.sort();
}

function isScannable(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (!SUPPORTED_EXTENSIONS[ext] && !STYLE_EXTENSIONS[ext]) return false;
  return !/\.(test|spec|stories)\.[jt]sx?$/.test(name) && !/\.min\.(js|css)$/.test(name) && !/\.module\.css\.d\.ts$/.test(name);
}

/** .ts files that may hold Angular components (read, then pre-checked for @Component + template:). */
function isAngularCandidate(name: string): boolean {
  return ANGULAR_EXTENSIONS.has(path.extname(name).toLowerCase()) && !name.endsWith(".d.ts") && !/\.(spec|test|stories)\.m?ts$/.test(name);
}

export async function scanStatic(target: string, opts: StaticOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const cwd = opts.cwd ?? process.cwd();
  const files = await collectFiles(path.resolve(cwd, target), opts.ignore);
  const findings: Finding[] = [];
  const absTarget = path.resolve(cwd, target);
  const resolver = opts.resolver ?? createResolver(path.relative(cwd, absTarget).startsWith("..") ? absTarget : cwd);
  let scanned = 0;
  for (const abs of files) {
    const source = await readFile(abs, "utf8");
    if (source.length > 2_000_000) continue;
    // Plain TypeScript (no Angular inline template) is not UI source: not scanned, not counted.
    if (isAngularCandidate(path.basename(abs)) && !mayHaveInlineTemplate(source)) continue;
    scanned++;
    // Outside cwd, a "../../.." path is useless in reports and SARIF; use the absolute path instead.
    const relative = path.relative(cwd, abs);
    const rel = (relative.startsWith("..") || path.isAbsolute(relative) ? abs : relative).split(path.sep).join("/") || path.basename(abs);
    findings.push(...analyzeSource(rel, source, { ...opts, cwd, resolver }));
  }
  return {
    tool: TOOL,
    target,
    kind: "static",
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    filesScanned: scanned,
    findings,
    discarded: 0,
  };
}
