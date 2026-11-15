import type { Attr, ElementNode } from "./ast.js";

export type Tri = "yes" | "no" | "unknown";

export function attr(el: ElementNode, name: string): Attr | undefined {
  return el.attrs.get(name);
}

export function has(el: ElementNode, name: string): boolean {
  return el.attrs.has(name);
}

/** Static attribute value, or undefined if missing or dynamic. */
export function sv(el: ElementNode, name: string): string | undefined {
  const a = el.attrs.get(name);
  return a && !a.dynamic && a.value !== null ? a.value : undefined;
}

export function isDynamic(el: ElementNode, name: string): boolean {
  return el.attrs.get(name)?.dynamic === true;
}

export function roleOf(el: ElementNode): string | undefined {
  return sv(el, "role")?.trim().split(/\s+/)[0]?.toLowerCase();
}

export function isAriaHidden(el: ElementNode): boolean {
  return sv(el, "aria-hidden") === "true" || has(el, "hidden");
}

/** True if a non-empty name attribute exists (aria-label, aria-labelledby, title) or is dynamic. */
export function nameFromAttrs(el: ElementNode): Tri {
  for (const n of ["aria-label", "aria-labelledby", "title"]) {
    const a = el.attrs.get(n);
    if (!a) continue;
    if (a.dynamic) return "unknown";
    if (a.value && a.value.trim()) return "yes";
  }
  return el.hasSpread ? "unknown" : "no";
}

/** Approximates whether the element's subtree contributes an accessible name. */
export function nameFromContent(el: ElementNode): Tri {
  let result: Tri = "no";
  for (const c of el.children) {
    if (c.type === "text") {
      if (c.dynamic) result = "unknown";
      else if (c.text.trim()) return "yes";
      continue;
    }
    if (isAriaHidden(c)) continue;
    if (c.isComponent) {
      // Icon components (XIcon, IconClose, ChevronSvg) render graphics, not text, unless given a label.
      if (isIconComponent(c)) {
        const viaAttrs = nameFromAttrs(c);
        if (viaAttrs === "yes" || sv(c, "label") || sv(c, "alt")) return "yes";
        if (viaAttrs === "unknown" || isDynamic(c, "label") || isDynamic(c, "alt")) result = "unknown";
        continue;
      }
      result = "unknown";
      continue;
    }
    if (c.tag === "img" || (c.tag === "input" && sv(c, "type") === "image")) {
      const alt = c.attrs.get("alt");
      if (alt?.dynamic) result = "unknown";
      else if (alt?.value?.trim()) return "yes";
      const viaAttrs = nameFromAttrs(c);
      if (viaAttrs === "yes") return "yes";
      if (viaAttrs === "unknown") result = "unknown";
      continue;
    }
    if (c.tag === "svg") {
      const viaAttrs = nameFromAttrs(c);
      if (viaAttrs === "yes") return "yes";
      if (viaAttrs === "unknown") result = "unknown";
      const title = c.children.find((x) => x.type === "element" && x.tag === "title");
      if (title && title.type === "element") {
        const t = nameFromContent(title);
        if (t === "yes") return "yes";
        if (t === "unknown") result = "unknown";
      }
      continue;
    }
    if (c.tag === "slot") {
      result = "unknown";
      continue;
    }
    const viaAttrs = nameFromAttrs(c);
    if (viaAttrs === "yes") return "yes";
    if (viaAttrs === "unknown") result = "unknown";
    const inner = nameFromContent(c);
    if (inner === "yes") return "yes";
    if (inner === "unknown") result = "unknown";
  }
  return result;
}

/** Accessible name from attributes OR content. */
export function accessibleName(el: ElementNode): Tri {
  const a = nameFromAttrs(el);
  if (a === "yes") return "yes";
  const c = nameFromContent(el);
  if (c === "yes") return "yes";
  if (a === "unknown" || c === "unknown") return "unknown";
  return "no";
}

export function ancestor(el: ElementNode, pred: (e: ElementNode) => boolean): ElementNode | undefined {
  let p = el.parent;
  while (p) {
    if (pred(p)) return p;
    p = p.parent;
  }
  return undefined;
}

export function* walk(el: ElementNode): Generator<ElementNode> {
  for (const c of el.children) {
    if (c.type === "element") {
      yield c;
      yield* walk(c);
    }
  }
}

export function hasClickHandler(el: ElementNode): boolean {
  return CLICK_HANDLERS.some((n) => el.attrs.has(n));
}

export function hasKeyHandler(el: ElementNode): boolean {
  // onKeyDown, Vue @keydown.enter (onkeydown.enter), React onKeyDownCapture / Svelte onkeydowncapture.
  return ["onkeydown", "onkeyup", "onkeypress"].some((n) => [...el.attrs.keys()].some((k) => k === n || k === n + "capture" || k.startsWith(n + ".")));
}

export function tabIndexValue(el: ElementNode): number | undefined {
  const v = sv(el, "tabindex");
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function isNativelyFocusable(el: ElementNode): boolean {
  if (el.tag === "a" || el.tag === "area") return has(el, "href");
  if (["button", "select", "textarea", "summary", "iframe"].includes(el.tag)) return !has(el, "disabled");
  if (el.tag === "input") return sv(el, "type") !== "hidden" && !has(el, "disabled");
  if ((el.tag === "audio" || el.tag === "video") && has(el, "controls")) return true;
  return false;
}

const ICON_COMPONENT = /(^Icon[A-Z0-9]?|Icon$|Svg$|^Svg[A-Z])/;

export function isIconComponent(el: ElementNode): boolean {
  const name = el.tag.split(".").pop() ?? "";
  return el.isComponent && (el.isIcon === true || ICON_COMPONENT.test(name));
}

// Capture-phase click handlers (onClickCapture) are deliberately not included: on a container they
// intercept clicks on descendants (links, buttons) rather than making the container a control.
const CLICK_HANDLERS = ["onclick", "onmousedown", "onmouseup", "onpointerdown", "onpointerup", "ontap"];

/** A handler that only stops propagation (`@click.stop`, `onClick={(e) => e.stopPropagation()}`) does nothing for the user. */
function isStopOnlyHandler(el: ElementNode, name: string): boolean {
  const a = el.attrs.get(name);
  if (!a) return false;
  const expr = (a.expr ?? "").trim();
  // Vue: @click.stop / @click.stop.prevent with no handler body.
  if (/\.(stop|prevent|self)\b/.test(a.rawName) && expr === "") return true;
  // (e) => e.stopPropagation()   /   e => { e.stopPropagation(); e.preventDefault(); }
  const m = /^(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\s*(?::\s*[\w.<>]+)?\s*\)?\s*=>\s*\{?([\s\S]*?)\}?$/.exec(expr);
  if (!m) return false;
  const v = m[1]!;
  const stmts = m[2]!.split(/[;\n]/).map((x) => x.trim()).filter(Boolean);
  // Compare whole statements as strings rather than building a RegExp from the parameter name.
  const calls = new Set(["stopPropagation", "preventDefault", "stopImmediatePropagation"].map((f) => `${v}.${f}()`));
  return stmts.length > 0 && stmts.every((x) => calls.has(x)) && stmts.some((x) => /stop/.test(x));
}

/** True if every click-like handler on the element only stops propagation. */
export function onlyStopsPropagation(el: ElementNode): boolean {
  const present = CLICK_HANDLERS.filter((n) => el.attrs.has(n));
  return present.length > 0 && present.every((n) => isStopOnlyHandler(el, n));
}

/** True if the subtree contains a native control. Clicks on it bubble to an ancestor handler, so keyboard users can still activate it. */
export function containsNativeControl(el: ElementNode): boolean {
  const base = el.ifDepth ?? 0;
  const always = (c: ElementNode): boolean => {
    for (let e: ElementNode | null = c; e && e !== el; e = e.parent) if (e.conditional) return false;
    return (c.ifDepth ?? 0) <= base;
  };
  for (const c of walk(el)) {
    if (c.isComponent || !always(c)) continue;
    if (c.tag === "button" || c.tag === "select" || c.tag === "textarea" || c.tag === "summary") return true;
    if (c.tag === "a" && has(c, "href")) return true;
    if (c.tag === "input" && sv(c, "type") !== "hidden") return true;
  }
  return false;
}

/** react-aria wrappers that inject tabIndex and keyboard handlers into their only child. */
const PROP_INJECTORS = /^(Pressable|Focusable|PressResponder|FocusableProvider)$/;

export function receivesInjectedInteraction(el: ElementNode): boolean {
  const p = el.parent;
  return !!p && p.isComponent && PROP_INJECTORS.test(p.tag.split(".").pop() ?? "");
}

/** True if the subtree contains an icon component (used to lower confidence of name findings). */
export function containsIconComponent(el: ElementNode): boolean {
  for (const c of walk(el)) if (isIconComponent(c)) return true;
  return false;
}
