import type { ElementNode } from "./ast.js";
import { sv } from "./helpers.js";
import { TAILWIND_V3, TAILWIND_V4 } from "./tailwind-palette.js";

/** A statically known color: the hex under the Tailwind v3 and v4 default palettes (equal for arbitrary values). */
export interface KnownColor {
  token: string;
  v3?: string;
  v4: string;
}

/** Result of reading a utility prefix (text-, bg-) from an element's classes. */
export type ColorLookup = { kind: "none" } | { kind: "unknown" } | { kind: "color"; color: KnownColor } | { kind: "transparent" };

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Static class tokens, or undefined when the class attribute is bound / spread (we can't know the classes). */
export function classTokens(el: ElementNode): string[] | undefined {
  const a = el.attrs.get("class");
  if (a?.dynamic) return undefined;
  if (el.hasSpread && !a) return undefined;
  return (sv(el, "class") ?? "").split(/\s+/).filter(Boolean);
}

/** Non-color utilities that share the text- prefix. */
const TEXT_NON_COLOR = /^text-((xs|sm|base|lg|[2-9]?xl)(\/.+)?|left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|opacity-\d+|\[length:.*\]|\[\d.*\])$/;
/** Non-color utilities that share the bg- prefix. */
const BG_NON_COLOR = /^bg-(auto|cover|contain|center|top|bottom|left|right|left-top|left-bottom|right-top|right-bottom|top-left|top-right|bottom-left|bottom-right|repeat|no-repeat|repeat-x|repeat-y|repeat-round|repeat-space|fixed|local|scroll|clip-.+|origin-.+|blend-.+|position-.+|size-.+|bottom-.+|top-.+|left-.+|right-.+)$/;

function resolve(token: string, value: string): KnownColor | "transparent" | undefined {
  if (value === "transparent") return "transparent";
  if (value === "white" || value === "black") return { token, v3: TAILWIND_V3.get(value)!, v4: TAILWIND_V4.get(value)! };
  const arb = /^\[(#[0-9a-fA-F]{3,6})\]$/.exec(value);
  if (arb && HEX.test(arb[1]!)) {
    const hex = expandHex(arb[1]!);
    return { token, v3: hex, v4: hex };
  }
  const v4 = TAILWIND_V4.get(value);
  if (!v4) return undefined;
  return { token, v3: TAILWIND_V3.get(value), v4 };
}

/**
 * The base (no variant) text-* or bg-* color set on this element itself. "unknown" for anything we
 * cannot resolve (theme colors like bg-primary, opacity modifiers, gradients, images, conflicting classes).
 */
export function ownColor(tokens: string[], prefix: "text" | "bg"): ColorLookup {
  const found: Array<KnownColor | "transparent"> = [];
  for (const t of tokens) {
    if (t.includes(":")) continue; // hover:, dark:, md:, … only apply in some states
    const bare = t.replace(/^!|!$/g, "");
    if (prefix === "bg" && /^bg-(gradient|linear|radial|conic|none|\[url)/.test(bare)) return { kind: "unknown" };
    if (prefix === "bg" && /^bg-opacity-/.test(bare)) return { kind: "unknown" };
    if (prefix === "text" && /^text-opacity-/.test(bare)) return { kind: "unknown" };
    if (!bare.startsWith(prefix + "-")) continue;
    if (prefix === "text" && TEXT_NON_COLOR.test(bare)) continue;
    if (prefix === "bg" && BG_NON_COLOR.test(bare)) continue;
    const value = bare.slice(prefix.length + 1);
    if (value.includes("/")) return { kind: "unknown" }; // text-gray-500/50: alpha
    const c = resolve(bare, value);
    if (!c) return { kind: "unknown" };
    found.push(c);
  }
  if (!found.length) return { kind: "none" };
  if (found.length > 1) return { kind: "unknown" };
  const c = found[0]!;
  return c === "transparent" ? { kind: "transparent" } : { kind: "color", color: c };
}

/** Font size in px from a text-* size utility, and whether a font-bold-or-heavier utility is present. */
export function fontInfo(tokens: string[]): { px?: number; bold?: boolean } {
  const SIZES: Record<string, number> = { xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "3xl": 30, "4xl": 36, "5xl": 48, "6xl": 60, "7xl": 72, "8xl": 96, "9xl": 128 };
  const out: { px?: number; bold?: boolean } = {};
  for (const t of tokens) {
    if (t.includes(":")) continue;
    const m = /^text-(xs|sm|base|lg|[2-9]?xl)(\/.+)?$/.exec(t);
    if (m) out.px = SIZES[m[1]!];
    if (/^font-(bold|extrabold|black)$/.test(t)) out.bold = true;
    else if (/^font-(thin|extralight|light|normal|medium|semibold)$/.test(t)) out.bold = false;
  }
  return out;
}

function expandHex(h: string): string {
  const s = h.slice(1).toLowerCase();
  return "#" + (s.length === 3 ? [...s].map((c) => c + c).join("") : s);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2 contrast ratio between two sRGB hex colors. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}
