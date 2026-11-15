/**
 * Map runtime findings back to source, best effort. The rendered element (its HTML from axe-core or the
 * keyboard audit) is searched for in the project's source by its most distinctive handles: test ids,
 * id, aria-label / alt / placeholder / name, project class names (not utility classes) and short text.
 * The best-scoring file and line become `sourceHint`. It is a hint: verify it before editing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { collectFiles } from "../static/analyze.js";
import type { ElementNode } from "../static/ast.js";
import { parseMarkup } from "../static/parse-html.js";
import type { Finding, ScanResult, SourceHint } from "../types.js";

interface Handle {
  /** What matched, for the report: data-testid="pay". */
  label: string;
  /** Literal text to look for in source. */
  needle: string;
  weight: number;
}

const TEST_ID = ["data-testid", "data-test-id", "data-test", "data-cy", "data-qa", "data-e2e"];
/** Utility-class shapes (Tailwind, Bootstrap helpers) that say nothing about which component rendered them. */
const UTILITY_CLASS = /^(-?(m|p)[trblxyse]?|w|h|min-[wh]|max-[wh]|size|gap|space-[xy]|text|font|leading|tracking|bg|border|rounded|shadow|ring|outline|flex|grid|col|row|items|justify|self|place|content|order|z|top|left|right|bottom|inset|opacity|cursor|select|pointer|transition|duration|ease|delay|animate|transform|scale|rotate|translate|overflow|truncate|whitespace|break|align|sr|not|hover|focus|active|disabled|group|peer|dark|sm|md|lg|xl|2xl|d|float|position|fw|fs|lh|me|ms|mt|mb|mx|my|pe|ps|pt|pb|px|py|visually|hidden|block|inline|absolute|relative|fixed|sticky|static|container|clearfix|btn|row|col|card|badge|active|show|fade|open|is|has|ng|css|jsx|svelte|astro|sc|emotion|chakra|mui|Mui|ant|p-|v-)([-:_/[]|$)/;

function elementOf(html: string): ElementNode | undefined {
  const doc = parseMarkup("evidence.html", html, "html");
  return doc.root.children.find((c): c is ElementNode => c.type === "element");
}

function textOf(el: ElementNode): string {
  let out = "";
  for (const c of el.children) out += c.type === "text" ? c.text : " " + textOf(c);
  return out.replace(/\s+/g, " ").trim();
}

/** Distinctive handles of a rendered element, strongest first. */
export function handlesFor(f: Finding): Handle[] {
  const el = elementOf(f.evidence);
  const out: Handle[] = [];
  const attrValue = (name: string) => {
    const a = el?.attrs.get(name);
    return a && !a.dynamic && a.value ? a.value.trim() : undefined;
  };
  for (const name of TEST_ID) {
    const v = attrValue(name);
    if (v) out.push({ label: `${name}="${v}"`, needle: v, weight: 10 });
  }
  const id = attrValue("id") ?? /^#([\w-]+)$/.exec(f.location.selector ?? "")?.[1];
  // Generated ids (radix-:r1:, headlessui-menu-3, mui-12, ember42) are not in the source.
  if (id && id.length > 2 && !/[:]|^(radix|headlessui|mui|react-aria|ember|ext-gen|_r_)|\d{2,}$|^[a-f0-9-]{16,}$/i.test(id)) out.push({ label: `id="${id}"`, needle: id, weight: 7 });
  for (const name of ["aria-label", "alt", "placeholder", "title", "name"]) {
    const v = attrValue(name);
    if (v && v.length >= 3 && v.length <= 80) out.push({ label: `${name}="${v}"`, needle: v, weight: name === "name" ? 4 : 5 });
  }
  if (el) {
    const text = textOf(el);
    if (text.length >= 3 && text.length <= 60 && /[A-Za-z]{3}/.test(text) && !text.endsWith("…")) out.push({ label: `text "${text}"`, needle: text, weight: 4 });
    const classes = (attrValue("class") ?? "").split(/\s+/).filter((c) => c.length >= 5 && !UTILITY_CLASS.test(c) && /[a-z]/.test(c) && !/^[a-z]+-[a-f0-9]{5,}$/i.test(c));
    for (const c of classes.slice(0, 3)) out.push({ label: `class "${c}"`, needle: c, weight: 3 });
  }
  return out;
}

/**
 * The line where the matched handles cluster: each occurrence of a handle scores its weight on the
 * lines around it (an element's attributes and text usually span a few lines).
 */
function bestLine(lines: string[], via: Handle[]): number {
  const score = new Float64Array(lines.length);
  const first = new Int32Array(lines.length).fill(-1);
  for (const h of via) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]!.includes(h.needle)) continue;
      for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 1); j++) {
        // Spread toward the opening tag above the attribute, strongest on the line itself.
        score[j] += h.weight * (j === i ? 1 : 0.6);
        if (first[j] === -1) first[j] = i;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < lines.length; i++) if (score[i]! > score[best]!) best = i;
  // Report the line of the strongest handle within the winning window, not the window's edge.
  for (const h of [...via].sort((a, b) => b.weight - a.weight)) {
    for (let i = Math.max(0, best - 1); i <= Math.min(lines.length - 1, best + 4); i++) if (lines[i]!.includes(h.needle)) return i;
  }
  return best;
}

export interface SourceHintOptions {
  cwd?: string;
  ignore?: string[];
}

/**
 * Add `sourceHint` to runtime findings in `results` by searching the source under `sourceDir`.
 * Returns how many findings got a hint.
 */
export async function addSourceHints(results: ScanResult[], sourceDir: string, opts: SourceHintOptions = {}): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const findings = results.filter((r) => r.kind === "runtime").flatMap((r) => r.findings);
  if (!findings.length) return 0;
  const handles = new Map<Finding, Handle[]>();
  const needles = new Set<string>();
  for (const f of findings) {
    const hs = handlesFor(f);
    handles.set(f, hs);
    for (const h of hs) needles.add(h.needle);
  }
  if (!needles.size) return 0;

  // One pass over the source: which files contain which needles.
  const files = await collectFiles(path.resolve(cwd, sourceDir), opts.ignore);
  const filesWith = new Map<string, string[]>();
  const contents = new Map<string, string>();
  const needleList = [...needles];
  for (const abs of files) {
    let src: string;
    try {
      src = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    if (src.length > 1_000_000) continue;
    let hit = false;
    for (const n of needleList) {
      if (!src.includes(n)) continue;
      const list = filesWith.get(n) ?? [];
      list.push(abs);
      filesWith.set(n, list);
      hit = true;
    }
    if (hit) contents.set(abs, src);
  }

  let hinted = 0;
  for (const f of findings) {
    const scores = new Map<string, { score: number; via: Handle[] }>();
    for (const h of handles.get(f) ?? []) {
      const where = filesWith.get(h.needle) ?? [];
      // A handle found in many files (a shared label, a common class) points nowhere in particular.
      if (!where.length || where.length > 5) continue;
      const w = h.weight / where.length;
      for (const file of where) {
        const s = scores.get(file) ?? { score: 0, via: [] };
        s.score += w;
        s.via.push(h);
        scores.set(file, s);
      }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);
    const best = ranked[0];
    // Needs one strong handle (test id, id) or two weaker ones that agree, and a clear winner.
    if (!best || best[1].score < 5 || (ranked[1] && ranked[1][1].score >= best[1].score * 0.8)) continue;
    const [file, { via }] = best;
    const lines = contents.get(file)!.split("\n");
    const idx = bestLine(lines, via);
    const rel = path.relative(cwd, file).split(path.sep).join("/");
    const hint: SourceHint = { file: rel.startsWith("..") ? file : rel, line: idx + 1, via: via.map((h) => h.label) };
    f.sourceHint = hint;
    hinted++;
  }
  return hinted;
}
