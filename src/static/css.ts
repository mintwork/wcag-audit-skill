/**
 * Tolerant stylesheet reader for .css / .scss / .less (and <style> blocks): enough structure to find
 * rules that remove the focus outline and to look for a focus style that replaces it. Never throws.
 */
import { lineStarts, positionAt } from "./ast.js";

export interface CssDecl {
  prop: string;
  value: string;
  offset: number;
}

export interface CssRule {
  /** Fully resolved selectors (SCSS / Less nesting and & expanded). */
  selectors: string[];
  decls: CssDecl[];
  /** Offset of the rule's prelude (selector) in the source. */
  offset: number;
  /** Source text of the selector as written. */
  prelude: string;
}

/** Blanks out comments (keeping offsets) so positions still match the source. */
function stripComments(src: string, lineComments: boolean): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      const end = stringEnd(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
      continue;
    }
    // `//` comments (SCSS / Less), but not inside url(http://…).
    if (lineComments && c === "/" && src[i + 1] === "/" && !/url\([^)]*$/.test(src.slice(Math.max(0, i - 200), i))) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function stringEnd(src: string, start: number): number {
  const q = src[start];
  let i = start + 1;
  while (i < src.length) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === q || src[i] === "\n") return i + 1;
    else i++;
  }
  return src.length;
}

/** Split a selector list on top-level commas (not inside :is(...), [attr="a,b"]). */
export function splitSelectors(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveNested(parents: string[], child: string): string[] {
  const kids = splitSelectors(child);
  if (!parents.length) return kids;
  const out: string[] = [];
  for (const p of parents) for (const k of kids) out.push(k.includes("&") ? k.replace(/&/g, p) : `${p} ${k}`);
  return out;
}

/** At-rules whose block holds normal rules under the same selector context. */
const TRANSPARENT_AT = /^@(media|supports|layer|container|document|scope|starting-style|include|if|else|each|for|while|at-root)\b/i;

export function parseCss(source: string, dialect: "css" | "scss" | "less"): CssRule[] {
  const src = stripComments(source, dialect !== "css");
  const rules: CssRule[] = [];
  /** Stack of open blocks: the rule they belong to (or null for at-rules / skipped blocks). */
  const stack: Array<{ rule: CssRule | null; selectors: string[]; skip: boolean }> = [];
  let segStart = 0;
  const current = () => stack[stack.length - 1];
  const ctxSelectors = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.selectors.length) return stack[i]!.selectors;
    return [];
  };
  const pushDecl = (text: string, offset: number) => {
    const top = current();
    if (!top?.rule || top.skip) return;
    const t = text.trim();
    if (!t) return;
    const lead = text.length - text.trimStart().length;
    if (t.startsWith("@apply")) {
      top.rule.decls.push({ prop: "@apply", value: t.slice(6).trim(), offset: offset + lead });
      return;
    }
    // SCSS @include / Less mixin calls (.focus-ring(); #ns.mixin();) may add any style.
    if (/^@include\b/.test(t) || /^[.#][\w-]+(\.[\w-]+)*\s*(\(.*\))?\s*(!important)?$/.test(t)) {
      top.rule.decls.push({ prop: "@include", value: t.replace(/^@include\s*/, ""), offset: offset + lead });
      return;
    }
    const m = /^([-\w]+)\s*:\s*([\s\S]*)$/.exec(t);
    if (m) top.rule.decls.push({ prop: m[1]!.toLowerCase(), value: m[2]!.trim(), offset: offset + lead });
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '"' || c === "'") {
      i = stringEnd(src, i) - 1;
      continue;
    }
    // SCSS interpolation #{…} is part of the selector / value, not a block.
    if (c === "#" && src[i + 1] === "{") {
      const end = src.indexOf("}", i);
      if (end !== -1) i = end;
      continue;
    }
    if (c === ";") {
      pushDecl(src.slice(segStart, i), segStart);
      segStart = i + 1;
    } else if (c === "{") {
      const raw = src.slice(segStart, i);
      const prelude = raw.trim();
      const lead = raw.length - raw.trimStart().length;
      const parent = current();
      const inSkip = parent?.skip ?? false;
      if (prelude.startsWith("@")) {
        stack.push({ rule: null, selectors: [], skip: inSkip || !TRANSPARENT_AT.test(prelude) });
        // Nested @media inside a rule still applies to that rule's selectors.
        if (TRANSPARENT_AT.test(prelude) && parent?.rule) stack[stack.length - 1]!.rule = parent.rule;
      } else if (inSkip || /\(\s*\)\s*$|\)\s*when\b/.test(prelude) || /^%/.test(prelude) || /^[\d.]+%$|^(from|to)$/.test(prelude)) {
        // Less mixin definitions `.m() {}`, SCSS placeholders `%x {}`, keyframe steps: not applied as written.
        stack.push({ rule: null, selectors: [], skip: true });
      } else {
        const selectors = resolveNested(ctxSelectors(), prelude);
        const rule: CssRule = { selectors, decls: [], offset: segStart + lead, prelude };
        rules.push(rule);
        stack.push({ rule, selectors, skip: false });
      }
      segStart = i + 1;
    } else if (c === "}") {
      pushDecl(src.slice(segStart, i), segStart);
      stack.pop();
      segStart = i + 1;
    }
  }
  return rules;
}

// ---------------------------------------------------------------------------------------------
// Focus outline analysis (WCAG 2.4.7)
// ---------------------------------------------------------------------------------------------

export interface OutlineIssue {
  line: number;
  column: number;
  evidence: string;
  message: string;
  fix: string;
  confidence: "high" | "medium";
}

const FOCUS = /:focus(-visible|-within)?\b|\.focus-visible\b|\[data-focus[\w-]*\]|\[data-highlighted\]|:-moz-focusring/;
const KEYBOARD_FOCUS = /:focus(-visible)?\b(?!-)|\.focus-visible\b|\[data-focus(-visible|ed)?(-added)?\]|:-moz-focusring/;
/** Removing the outline only when focus is NOT keyboard focus is the recommended pattern. */
const NOT_KEYBOARD_FOCUS = /:not\(\s*(:focus-visible|\.focus-visible|\[data-focus-visible-added\])\s*\)|::-moz-focus-inner|:focus:not\(:focus-visible\)/;
/** Selectors that target things keyboard users focus. */
const FOCUSABLE_TARGET = /(^|[\s>+~(,])(a|button|input|select|textarea|summary|\*)(?=$|[\s.:#[>+~),])|\[tabindex(?!=["']?-1)|\[contenteditable|\[role=["']?(button|link|tab|menuitem|checkbox|radio|switch|option|slider|combobox)|[.#][\w-]*(btn|button|link|input|select|tab|control|field|toggle|menu-?item|checkbox|radio|switch|nav-item|dropdown-item)\b/i;
/** Text-entry fields: the caret shows where focus is and wrappers often draw the ring (focus-within) elsewhere. */
const TEXT_ENTRY = /(^|[\s>+~(,])(input(?!\[type=["']?(checkbox|radio|range|submit|button|reset|color|file)\b)|textarea)(?=$|[\s.:#[>+~),])|\[contenteditable|[.#][\w-]*(input|textarea|editor|field|form-control|search)\b/i;

function removesOutline(d: CssDecl): boolean {
  const v = d.value.replace(/!important/i, "").trim().toLowerCase();
  // `transparent` as the outline color, but not inside color-mix(…, transparent 70%).
  let top = v;
  for (let prev = ""; prev !== top; ) [prev, top] = [top, top.replace(/\([^()]*\)/g, "")];
  if (d.prop === "outline") return /^(none|0|0px|0 none|none 0)$/.test(v) || /(^|\s)transparent(\s|$)/.test(top);
  if (d.prop === "outline-style") return v === "none";
  if (d.prop === "outline-width") return v === "0" || v === "0px";
  if (d.prop === "@apply") return applyTokens(d.value).some(isOutlineNoneToken);
  return false;
}

/** A declaration that makes focus visible some other way (or might: mixins). */
function visibleFocusStyle(d: CssDecl): boolean {
  const v = d.value.replace(/!important/i, "").trim().toLowerCase();
  if (d.prop === "@include") return true;
  // Inside a focus rule, any utility other than outline-none changes how focus looks (ring, bg, scale, …).
  if (d.prop === "@apply") return applyTokens(d.value).some((t) => !isOutlineNoneToken(t) && !/^(transition|duration|ease|delay|cursor|select|pointer-events)/.test(t.split(":").pop()!));
  if (d.prop.startsWith("outline")) return !removesOutline(d) && d.prop !== "outline-offset";
  if (d.prop === "box-shadow") return v !== "none" && v !== "0" && v !== "";
  return /^(border(-[a-z-]+)?|background(-color|-image)?|color|text-decoration(-[a-z]+)?|text-underline-offset|filter|transform|scale|translate|opacity|--[\w-]*(focus|ring|shadow|border)[\w-]*)$/.test(d.prop);
}

function applyTokens(v: string): string[] {
  return v.replace(/!important/g, "").split(/\s+/).filter(Boolean);
}

/** outline-none, outline-hidden, outline-0, focus:outline-none, focus-visible:outline-0, … (not outline-transparent: it only sets the color) */
export function isOutlineNoneToken(t: string): boolean {
  const parts = t.replace(/^!|!$/g, "").split(":");
  const util = parts[parts.length - 1]!.replace(/^!|!$/g, "");
  const variants = parts.slice(0, -1);
  if (!/^(outline-none|outline-hidden|outline-0)$/.test(util)) return false;
  // Only variants under which keyboard focus loses its outline: always, on focus, per breakpoint / theme.
  // State variants (hover:, data-[state=open]:, aria-selected:, group-*) are too narrow to judge.
  return variants.every((v) => /^(focus|focus-visible|sm|md|lg|xl|2xl|dark|motion-safe|motion-reduce|(max|min)-.+)$/.test(v));
}

/**
 * A class that draws a focus indicator: focus:ring-2, focus-visible:outline-2, focus-within:shadow,
 * data-[focus-visible]:…, data-highlighted:bg-… (menus, listboxes), or a "focus-ring" helper class.
 */
export function isFocusReplacementToken(t: string): boolean {
  const parts = t.replace(/^!/, "").split(":");
  const util = parts[parts.length - 1]!.replace(/^!|!$/g, "");
  const variants = parts.slice(0, -1);
  if (isOutlineNoneToken(t)) return false;
  if (!variants.length) return /focus/i.test(util); // focus-ring, focusable-outline helpers
  if (!variants.some((v) => /focus|highlight|ui-active|data-\[?active|data-\[?selected|aria-selected/.test(v))) return false;
  return /^(ring|outline|shadow|border|bg-|underline|decoration|text-|inset-ring|scale|translate|opacity|z-|after|before|inset-shadow)/.test(util);
}

/** Selector without state pseudo-classes: `.btn:focus-visible:hover` → `.btn`. */
function baseOf(sel: string): string {
  return sel
    .replace(/:not\([^)]*\)/g, "")
    .replace(/:(focus-visible|focus-within|focus|hover|active|visited|enabled|-moz-focusring)\b/g, "")
    .replace(/\.focus-visible\b|\[data-focus[\w-]*\]|\[data-highlighted\]/g, "")
    .replace(/\s*([>+~])\s*/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `a` is `b`, or one is a descendant / sibling / pseudo-element path of the other. */
function related(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short !== "" && long.startsWith(short) && /^[\s:[.]/.test(long.slice(short.length));
}

function lastCompound(sel: string): string {
  const parts = sel.split(/\s*[\s>+~]\s*/).filter(Boolean);
  return parts[parts.length - 1] ?? sel;
}

/** Generated utility CSS (a compiled Tailwind build): the utilities are judged where they are used. */
function isGenerated(source: string): boolean {
  return /^\s*\/\*!?\s*tailwindcss v\d/i.test(source) || (source.length > 200_000 && /\.focus\\:outline-none/.test(source));
}

/**
 * Rules that remove the outline from focusable elements with no focus style replacing it in the same
 * stylesheet. `offset` / `whole` map positions for <style> blocks embedded in markup.
 */
export function outlineIssues(source: string, dialect: "css" | "scss" | "less", offset = 0, whole = source): OutlineIssue[] {
  if (isGenerated(source)) return [];
  const rules = parseCss(source, dialect);
  const starts = lineStarts(whole);
  // Focus styles in this stylesheet that draw something visible, by base selector.
  const replacements: string[] = [];
  let globalFocusStyle = false;
  let wrapperFocusStyles = false;
  for (const r of rules) {
    if (!r.decls.some(visibleFocusStyle)) continue;
    for (const sel of r.selectors) {
      if (!FOCUS.test(sel) || NOT_KEYBOARD_FOCUS.test(sel)) continue;
      const b = baseOf(sel);
      replacements.push(b);
      // .card:has(.link:focus-visible) { outline: … } draws the ring for .link on its container.
      for (const m of sel.matchAll(/:has\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) if (FOCUS.test(m[1]!)) replacements.push(baseOf(m[1]!.replace(/^[\s>+~]+/, "")));
      if (/:focus-within|:has\(/.test(sel)) wrapperFocusStyles = true;
      if (b === "" || b === "*" || /^(html|body|:root|:where\(.*\)|:is\(.*\))$/.test(b)) globalFocusStyle = true;
    }
  }
  const isReplaced = (sel: string) => {
    const b = baseOf(sel);
    const last = lastCompound(b);
    // `.react-calendar button { outline: none }` with `.react-calendar__tile:focus { background: … }`: an
    // element-type selector inside a component scope that has its own focus styles.
    const first = b.split(/\s*[\s>+~]\s*/)[0]!;
    const scoped = /^[a-z]+$/.test(last) && /^[.#]/.test(first) && first !== last;
    const prefix = first.replace(/[-_]+$/, "");
    return replacements.some(
      (r) => related(r, b) || r === last || (r !== "" && lastCompound(r) === last && !/[\s>+~]/.test(r)) || (scoped && r.startsWith(prefix)),
    );
  };
  const out: OutlineIssue[] = [];
  for (const r of rules) {
    const removal = r.decls.find(removesOutline);
    if (!removal) continue;
    // The same rule may draw its own replacement (`:focus { outline: none; box-shadow: 0 0 0 3px … }`).
    if (r.decls.some((d) => d !== removal && visibleFocusStyle(d)) && r.selectors.some((s) => FOCUS.test(s))) continue;
    if (removal.prop === "@apply" && applyTokens(removal.value).some(isFocusReplacementToken)) continue;
    const offending = r.selectors.filter((s) => {
      if (NOT_KEYBOARD_FOCUS.test(s) || /\[tabindex=["']?-1/.test(s) || /:focus-within/.test(s)) return false;
      if (/\\:/.test(s) || /^\.(focus(-visible)?\\?:)?outline-(none|0|hidden)\b/.test(s)) return false; // utility class definitions
      if (/:(hover|active)\b/.test(s) && !KEYBOARD_FOCUS.test(s)) return false; // a:hover { outline: 0 } (normalize.css)
      const applyFocus = removal.prop === "@apply" && applyTokens(removal.value).some((t) => isOutlineNoneToken(t) && /^!?focus/.test(t));
      if (!KEYBOARD_FOCUS.test(s) && !applyFocus && !FOCUSABLE_TARGET.test(s)) return false;
      // Text-entry fields are left alone: the caret shows focus, and wrappers often draw the ring (:focus-within).
      if (TEXT_ENTRY.test(s)) return false;
      return !isReplaced(s);
    });
    if (!offending.length) continue;
    const focusSpecific = offending.some((s) => KEYBOARD_FOCUS.test(s));

    const pos = positionAt(starts, offset + r.offset);
    const decl = removal.prop === "@apply" ? `@apply ${applyTokens(removal.value).filter(isOutlineNoneToken).join(" ")}` : `${removal.prop}: ${removal.value}`;
    const hint = globalFocusStyle
      ? " (a global :focus-visible rule exists, but this more specific rule may override it)"
      : wrapperFocusStyles
        ? " (this stylesheet has :focus-within / :has() styles; check whether one covers this element)"
        : "";
    out.push({
      line: pos.line,
      column: pos.column,
      evidence: `${r.prelude.replace(/\s+/g, " ")} { ${decl} }`,
      confidence: focusSpecific && !globalFocusStyle && !wrapperFocusStyles && dialect === "css" ? "high" : "medium",
      message: `${decl} on ${offending[0]}${offending.length > 1 ? ` (+${offending.length - 1} more)` : ""} removes the focus indicator, and no focus style in this stylesheet replaces it, so keyboard users cannot see where focus is${hint}.`,
      fix: `Keep the outline, or add a visible replacement, e.g. ${baseOf(offending[0]!) || "*"}:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }. To hide it only for mouse clicks, use :focus:not(:focus-visible) { outline: none }.`,
    });
  }
  return out;
}

/** <style> blocks inside HTML, Vue, Svelte and Astro files: [content, offset, dialect]. */
export function styleBlocks(source: string): Array<{ css: string; offset: number; dialect: "css" | "scss" | "less" }> {
  const out: Array<{ css: string; offset: number; dialect: "css" | "scss" | "less" }> = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const lang = /\blang=["']?(scss|sass|less|stylus|postcss|css)/i.exec(m[1]!)?.[1]?.toLowerCase();
    if (lang === "sass" || lang === "stylus") continue; // indentation syntaxes: not parsed
    out.push({ css: m[2]!, offset: m.index + m[0].indexOf(">") + 1, dialect: lang === "scss" ? "scss" : lang === "less" ? "less" : "css" });
  }
  return out;
}
