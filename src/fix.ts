/**
 * `--fix` for mechanical rules: html-lang, meta-viewport-zoom and aria-attr-valid typos. Each fix is a
 * small edit inside one opening tag, so files keep their line count and the diff stays readable.
 * Nothing is written without the diff being shown first (and nothing at all with --dry-run).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ARIA_ATTRIBUTES, distance } from "./static/aria.js";
import { type ElementNode, lineStarts } from "./static/ast.js";
import { analyzeSource, parseFile } from "./static/analyze.js";
import { walk } from "./static/helpers.js";
import type { Finding } from "./types.js";

export const FIXABLE_RULES = ["html-lang", "meta-viewport-zoom", "aria-attr-valid"];

export interface FixOptions {
  /** Language for <html> elements that have no lang at all (never guessed). */
  lang?: string;
  cwd?: string;
}

export interface AppliedFix {
  ruleId: string;
  line: number;
  description: string;
}

export interface SkippedFix {
  ruleId: string;
  line: number;
  reason: string;
}

export interface FileFix {
  file: string;
  before: string;
  after: string;
  applied: AppliedFix[];
  skipped: SkippedFix[];
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Common language names and malformed tags → BCP 47. */
const LANG_NAMES: Record<string, string> = {
  english: "en", french: "fr", francais: "fr", german: "de", deutsch: "de", spanish: "es", espanol: "es",
  italian: "it", portuguese: "pt", dutch: "nl", japanese: "ja", chinese: "zh", korean: "ko", russian: "ru",
  arabic: "ar", hindi: "hi", polish: "pl", swedish: "sv", turkish: "tr", danish: "da", norwegian: "no",
  finnish: "fi", czech: "cs", greek: "el", hebrew: "he", ukrainian: "uk", indonesian: "id", vietnamese: "vi",
  thai: "th",
};
const VALID_LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i;

/** "en_US" → "en-US", "English" → "en", "EN-us" → "en-US"; undefined if it can't be repaired safely. */
export function normalizeLang(value: string): string | undefined {
  const v = value.trim();
  const named = LANG_NAMES[v.toLowerCase()];
  if (named) return named;
  const parts = v.replace(/_/g, "-").split("-");
  if (!/^[a-z]{2,3}$/i.test(parts[0]!)) return undefined;
  const out = [parts[0]!.toLowerCase(), ...parts.slice(1).map((p) => (/^[a-z]{2}$/i.test(p) ? p.toUpperCase() : /^[a-z]{4}$/i.test(p) ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : p))].join("-");
  return VALID_LANG.test(out) && out !== v ? out : undefined;
}

/** Viewport content without user-scalable=no / 0 and maximum-scale below 2. */
export function fixViewportContent(content: string): string {
  const parts = content.split(/\s*[,;]\s*/).filter(Boolean);
  const kept = parts.filter((p) => {
    const [k, val = ""] = p.split("=").map((s) => s.trim().toLowerCase());
    if (k === "user-scalable") return !/^(no|0)$/.test(val);
    if (k === "maximum-scale") return !(Number(val) < 2);
    return true;
  });
  return kept.join(", ");
}

/** The attribute `name="value"` (any quote style, or unquoted) inside an opening tag. */
function findAttr(openTag: string, rawName: string): { start: number; end: number; valueStart: number; valueEnd: number; quote: string } | undefined {
  const esc = rawName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s"'])(${esc})(\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+)))?(?=[\\s/>]|$)`);
  const m = re.exec(openTag);
  if (!m) return undefined;
  const start = m.index + m[1]!.length;
  const end = start + m[2]!.length + (m[3]?.length ?? 0);
  const quote = m[4] !== undefined ? '"' : m[5] !== undefined ? "'" : "";
  const value = m[4] ?? m[5] ?? m[6] ?? "";
  const valueEnd = m[3] ? end - quote.length : end;
  return { start, end, valueStart: valueEnd - value.length, valueEnd, quote };
}

function fixFor(f: Finding, el: ElementNode, opts: FixOptions): { edits: Array<{ start: number; end: number; text: string }>; description: string } | string {
  const tag = el.openTag;
  if (f.ruleId === "html-lang") {
    const raw = el.attrs.get("lang")?.rawName ?? el.attrs.get("xml:lang")?.rawName;
    const attr = raw ? findAttr(tag, raw) : undefined;
    if (!attr) {
      if (!opts.lang) return "no lang attribute: pass --lang <code> (e.g. --lang en) to add one; the language is never guessed";
      if (!VALID_LANG.test(opts.lang)) return `--lang ${opts.lang} is not a valid language tag`;
      const at = /^<html/i.exec(tag)![0].length;
      return { edits: [{ start: at, end: at, text: ` lang="${opts.lang}"` }], description: `added lang="${opts.lang}"` };
    }
    const current = tag.slice(attr.valueStart, attr.valueEnd);
    if (!current.trim()) {
      if (!opts.lang) return "empty lang: pass --lang <code> to set it";
      return { edits: [{ start: attr.valueStart, end: attr.valueEnd, text: opts.lang }], description: `set lang="${opts.lang}"` };
    }
    const fixed = normalizeLang(current);
    if (!fixed) return `lang="${current}" cannot be repaired mechanically`;
    return { edits: [{ start: attr.valueStart, end: attr.valueEnd, text: fixed }], description: `lang="${current}" → lang="${fixed}"` };
  }
  if (f.ruleId === "meta-viewport-zoom") {
    const raw = el.attrs.get("content")?.rawName;
    const attr = raw ? findAttr(tag, raw) : undefined;
    if (!attr) return "content attribute not found";
    const current = tag.slice(attr.valueStart, attr.valueEnd);
    const fixed = fixViewportContent(current);
    if (fixed === current) return "nothing to change";
    return { edits: [{ start: attr.valueStart, end: attr.valueEnd, text: fixed }], description: `content="${current}" → content="${fixed}"` };
  }
  if (f.ruleId === "aria-attr-valid") {
    const edits: Edit[] = [];
    const renamed: string[] = [];
    for (const a of el.attrs.values()) {
      if (!a.name.startsWith("aria-") || ARIA_ATTRIBUTES.has(a.name)) continue;
      // A typo, not an unknown attribute: one or two edits away from exactly one ARIA attribute.
      const close = [...ARIA_ATTRIBUTES].filter((n) => distance(a.name, n) <= 2);
      if (close.length !== 1) continue;
      const target = close[0]!;
      if (el.attrs.has(target)) continue; // the correct one is already there
      const attr = findAttr(tag, a.rawName);
      // Keep binding prefixes (:aria-x, v-bind:aria-x, [attr.aria-x]): rename only the attribute name.
      const at = a.rawName.toLowerCase().indexOf(a.name);
      if (!attr || at === -1) continue;
      edits.push({ start: attr.start + at, end: attr.start + at + a.name.length, text: target });
      renamed.push(`${a.rawName} → ${target}`);
    }
    if (!edits.length) return "no unambiguous typo to rename";
    return { edits, description: `renamed ${renamed.join(", ")}` };
  }
  return "not fixable";
}

/** Fix one file's source. Pure: returns the new text and what was (not) done. */
export function fixSource(file: string, source: string, opts: FixOptions = {}): FileFix {
  const findings = analyzeSource(file, source, { rules: FIXABLE_RULES, cwd: opts.cwd });
  const result: FileFix = { file, before: source, after: source, applied: [], skipped: [] };
  if (!findings.length) return result;
  const doc = parseFile(file, source);
  // MDX is rewritten before parsing, so element offsets don't map back to the file.
  if (!doc || (doc.framework as string) === "mdx") {
    for (const f of findings) result.skipped.push({ ruleId: f.ruleId, line: f.location.line ?? 0, reason: "fixes are not applied to this file type" });
    return result;
  }
  const starts = lineStarts(source);
  const byPos = new Map<string, ElementNode>();
  for (const el of walk(doc.root)) byPos.set(`${el.line}:${el.column}`, el);
  const edits: Edit[] = [];
  const seen = new Set<ElementNode>();
  for (const f of findings) {
    const el = byPos.get(`${f.location.line}:${f.location.column}`);
    const line = f.location.line ?? 0;
    if (!el || seen.has(el)) continue;
    seen.add(el);
    const offset = starts[el.line - 1]! + el.column - 1;
    // Only edit text we can see verbatim in the file.
    if (source.slice(offset, offset + el.openTag.length) !== el.openTag) {
      result.skipped.push({ ruleId: f.ruleId, line, reason: "element text not found verbatim" });
      continue;
    }
    const fix = fixFor(f, el, opts);
    if (typeof fix === "string") {
      result.skipped.push({ ruleId: f.ruleId, line, reason: fix });
      continue;
    }
    for (const e of fix.edits) edits.push({ start: offset + e.start, end: offset + e.end, text: e.text });
    result.applied.push({ ruleId: f.ruleId, line, description: fix.description });
  }
  edits.sort((a, b) => b.start - a.start);
  let out = source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  result.after = out;
  return result;
}

/** Unified diff of two versions with the same line count (fixes never add or remove lines). */
export function unifiedDiff(file: string, before: string, after: string, context = 2): string {
  if (before === after) return "";
  // A final newline ends the last line; it is not an extra empty line.
  const lines = (s: string) => (s.endsWith("\n") ? s.slice(0, -1) : s).split("\n");
  const a = lines(before);
  const b = lines(after);
  const eol = (s: string, k: number, len: number) => (k === len - 1 && !s.endsWith("\n") ? ["\\ No newline at end of file"] : []);
  const changed: number[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) changed.push(i);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  let i = 0;
  while (i < changed.length) {
    let j = i;
    while (j + 1 < changed.length && changed[j + 1]! - changed[j]! <= context * 2 + 1) j++;
    const from = Math.max(0, changed[i]! - context);
    const to = Math.min(n - 1, changed[j]! + context);
    const len = to - from + 1;
    out.push(`@@ -${from + 1},${len} +${from + 1},${len} @@`);
    for (let k = from; k <= to; k++) {
      if (a[k] === b[k]) {
        out.push(` ${a[k] ?? ""}`, ...eol(before, k, a.length));
        continue;
      }
      // A run of changed lines: all removals, then all additions.
      let end = k;
      while (end + 1 <= to && a[end + 1] !== b[end + 1]) end++;
      for (let x = k; x <= end; x++) if (a[x] !== undefined) out.push(`-${a[x]}`, ...eol(before, x, a.length));
      for (let x = k; x <= end; x++) if (b[x] !== undefined) out.push(`+${b[x]}`, ...eol(after, x, b.length));
      k = end;
    }
    i = j + 1;
  }
  return out.join("\n");
}

/** Compute fixes for files (relative to cwd). Nothing is written: show the diff, then call writeFixes. */
export async function planFixes(files: string[], opts: FixOptions = {}): Promise<FileFix[]> {
  const cwd = opts.cwd ?? process.cwd();
  const out: FileFix[] = [];
  for (const file of [...new Set(files)].sort()) {
    const abs = path.resolve(cwd, file);
    const source = await readFile(abs, "utf8");
    const r = fixSource(file, source, opts);
    if (r.after !== r.before && r.after.split("\n").length !== r.before.split("\n").length) {
      // Never expected; refuse rather than write something the diff did not show faithfully.
      r.skipped.push(...r.applied.map((x) => ({ ruleId: x.ruleId, line: x.line, reason: "fix would change the line count" })));
      r.applied = [];
      r.after = r.before;
    }
    if (r.applied.length || r.skipped.length) out.push(r);
  }
  return out;
}

/** Write planned fixes. Refuses a file that changed on disk since it was planned. */
export async function writeFixes(fixes: FileFix[], cwd = process.cwd()): Promise<number> {
  let written = 0;
  for (const f of fixes) {
    if (f.after === f.before) continue;
    const abs = path.resolve(cwd, f.file);
    if ((await readFile(abs, "utf8")) !== f.before) throw new Error(`${f.file} changed while fixing; nothing written to it`);
    await writeFile(abs, f.after);
    written++;
  }
  return written;
}
