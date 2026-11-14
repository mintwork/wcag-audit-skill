/**
 * A tiny framework-neutral markup tree. HTML, Vue, Svelte, Astro and JSX/TSX
 * sources are all normalized into this shape so rules are written once.
 */

export type Framework = "html" | "vue" | "svelte" | "astro" | "jsx";

export interface Attr {
  /** Normalized, lowercase attribute name (className -> class, @click -> onclick). */
  name: string;
  /** Attribute name as written in the source. */
  rawName: string;
  /** Static value, or null when the value is a runtime expression. */
  value: string | null;
  /** True when the value is bound to an expression whose value we cannot know statically. */
  dynamic: boolean;
  /** Source text of the bound expression, when the parser has it (handler bodies, etc.). */
  expr?: string;
}

export interface ElementNode {
  type: "element";
  /** Lowercase tag name for intrinsic elements, original casing for components. */
  tag: string;
  /** True for framework components (<MyButton>, <motion.div>) rather than HTML elements. */
  isComponent: boolean;
  /** Component imported from a known icon library (lucide-react, @mui/icons-material, …). */
  isIcon?: boolean;
  /** JSX only: name of the enclosing top-level component/function, used to scope per-component checks. */
  scope?: string;
  /** Rendered only under a condition: v-if / v-show, {cond && <x/>}, {a ? <x/> : <y/>}. */
  conditional?: boolean;
  /** Svelte/Astro: number of enclosing {#if} blocks; a descendant with a higher depth is conditional relative to this element. */
  ifDepth?: number;
  attrs: Map<string, Attr>;
  /** Element has a spread / v-bind="obj" / {...props}: unknown attributes may be present. */
  hasSpread: boolean;
  /** JSX only: source of each spread argument ("props", "getInputProps()"). */
  spreads?: string[];
  children: Node[];
  parent: ElementNode | null;
  /** 1-based line / column of the opening tag. */
  line: number;
  column: number;
  /** Source text of the opening tag (used as evidence). */
  openTag: string;
}

export interface TextNode {
  type: "text";
  text: string;
  /** True when this text is (or contains) an expression: {name}, {{ msg }}, etc. */
  dynamic: boolean;
  /** Source of the expression, when known (JSX). */
  expr?: string;
}

export type Node = ElementNode | TextNode;

export interface ParsedDocument {
  file: string;
  framework: Framework;
  source: string;
  root: ElementNode;
  /** Problems the parser hit; the file is still scanned best-effort. */
  parseErrors: string[];
  /** JSX only: top-level JSX trees of each component defined in this file, by name. */
  components?: Map<string, ElementNode[]>;
  /** JSX only: imports and exports, used to find a component's definition in another file. */
  modules?: ModuleInfo;
}

export interface ModuleInfo {
  /** Local name → where it comes from ("default", a named export, or "*" for a namespace). */
  imports: Map<string, { source: string; imported: string }>;
  /** Exported name ("default" included) → local name. */
  exports: Map<string, string>;
  /** export { A as B } from "./x" */
  reexports: Array<{ exported: string; imported: string; source: string }>;
  /** export * from "./x" */
  exportAll: string[];
}

export function createRoot(): ElementNode {
  return {
    type: "element",
    tag: "#root",
    isComponent: false,
    attrs: new Map(),
    hasSpread: false,
    children: [],
    parent: null,
    line: 1,
    column: 1,
    openTag: "",
  };
}

export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

export function positionAt(starts: number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - starts[lo]! + 1 };
}

const EVENT_ALIASES: Record<string, string> = {
  ondoubleclick: "ondblclick",
};

/**
 * Normalize an attribute name across frameworks. Returns null for attributes
 * that carry no a11y meaning (directives like v-if, class:active, bind:this).
 */
export function normalizeAttrName(
  raw: string,
  framework: Framework,
): { name: string; forceDynamic: boolean } | null {
  let name = raw;
  let forceDynamic = false;

  if (framework === "jsx") {
    if (name === "className") name = "class";
    else if (name === "htmlFor") name = "for";
    return { name: name.toLowerCase(), forceDynamic };
  }

  // Vue: @click, v-on:click, :alt, v-bind:alt
  if (name.startsWith("@")) return { name: "on" + stripModifiers(name.slice(1)).toLowerCase(), forceDynamic: true };
  if (name.startsWith("v-on:")) return { name: "on" + stripModifiers(name.slice(5)).toLowerCase(), forceDynamic: true };
  if (name.startsWith("v-bind:")) {
    name = name.slice(7);
    forceDynamic = true;
  } else if (name.startsWith(":")) {
    name = name.slice(1);
    forceDynamic = true;
  } else if (name.startsWith("v-")) {
    // v-model gives inputs a value binding but no label; v-if / v-for are structure.
    return null;
  }

  // Svelte: on:click|preventDefault, bind:value, class:active, use:action
  if (name.startsWith("on:")) return { name: "on" + name.slice(3).split("|")[0]!.toLowerCase(), forceDynamic: true };
  if (/^(bind|class|style|use|transition|in|out|animate|let):/.test(name)) return null;

  // Angular: (click), [alt], [attr.aria-label], [(ngModel)]
  if (name.startsWith("[(")) return null;
  if (name.startsWith("(") && name.endsWith(")")) return { name: "on" + name.slice(1, -1).toLowerCase(), forceDynamic: true };
  if (name.startsWith("[") && name.endsWith("]")) {
    name = name.slice(1, -1).replace(/^attr\./, "");
    forceDynamic = true;
  }

  // Astro: client:load etc.
  if (/^(client|set|is|server):/.test(name)) return null;

  name = name.toLowerCase();
  name = EVENT_ALIASES[name] ?? name;
  return { name, forceDynamic };
}

function stripModifiers(s: string): string {
  return s.split(".")[0]!;
}

export const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

export function truncate(s: string, max = 240): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max - 1) + "…" : one;
}
