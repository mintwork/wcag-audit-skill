import { isFocusReplacementToken, isOutlineNoneToken } from "./css.js";
import type { ElementNode } from "./ast.js";
import { has, isNativelyFocusable, roleOf, sv, tabIndexValue, walk } from "./helpers.js";
import { INTERACTIVE_ROLES } from "./aria.js";
import type { Rule } from "./rules.js";

/** Class helpers whose string arguments are the classes: cn("…"), clsx(…), twMerge(…), cva("…"). */
const CLASS_HELPER = /^\s*(cn|clsx|classnames|classNames|cx|twMerge|twJoin|tw|cva|tv)\s*\(/;

/**
 * Class tokens of an element. For bound classes built from string literals (cn("a b", cond && "c"),
 * template literals, Vue :class strings), the union of the literals, flagged as partial.
 */
function classInfo(el: ElementNode): { tokens: string[]; partial: boolean } | undefined {
  const a = el.attrs.get("class");
  if (!a) return el.hasSpread ? undefined : { tokens: [], partial: false };
  if (!a.dynamic) return { tokens: (a.value ?? "").split(/\s+/).filter(Boolean), partial: el.hasSpread };
  const expr = a.expr ?? "";
  if (!CLASS_HELPER.test(expr) && !/^\s*[`'"[]/.test(expr)) return undefined;
  // Every word in the expression, including classes inside ${cond ? "ring-2" : ""} and { 'a': x } keys.
  return { tokens: expr.split(/[\s'"`{}$?,+|&]+/).filter(Boolean), partial: true };
}

/** "text" for text-entry fields: the caret shows focus, and wrappers often draw the ring (focus-within) elsewhere. */
function focusableKind(el: ElementNode): "native" | "text" | undefined {
  const t = tabIndexValue(el);
  if (t !== undefined && t < 0) return undefined; // programmatic focus targets (dialogs, skip-link targets)
  if (el.attrs.get("tabindex")?.dynamic) return undefined; // tabindex={-1} in Svelte, tabIndex={active ? 0 : -1}
  // Components (<DropdownMenuItem className="outline-none">) merge classes into their own styles, which
  // usually carry the focus state (focus:bg-accent, data-highlighted:…); they are judged where defined.
  if (el.isComponent) return undefined;
  // Composite widgets show focus on the active option / item (aria-activedescendant, roving highlight).
  if (has(el, "aria-activedescendant") || ["listbox", "menu", "menubar", "grid", "tree", "treegrid", "tablist", "radiogroup", "toolbar"].includes(roleOf(el) ?? "")) return undefined;
  if (el.tag === "textarea" || (el.tag === "input" && !["checkbox", "radio", "range", "submit", "button", "reset", "color", "file", "image"].includes((sv(el, "type") ?? "text").toLowerCase()))) return isNativelyFocusable(el) ? "text" : undefined;
  if (sv(el, "contenteditable") === "true" || sv(el, "contenteditable") === "") return "text";
  if (isNativelyFocusable(el)) return "native";
  if (t !== undefined && t >= 0) return "native";
  const role = roleOf(el);
  if (role && INTERACTIVE_ROLES.has(role) && t !== undefined) return "native";
  return undefined;
}

/** focus-within:ring on a wrapper, peer-focus: on a sibling, group-focus: inside a `group`. */
function replacedNearby(el: ElementNode): { replaced: boolean; viaComponent: boolean } {
  let viaComponent = false;
  for (let p = el.parent; p && p.tag !== "#root"; p = p.parent) {
    if (p.isComponent) viaComponent = true;
    const info = classInfo(p);
    if (!info) {
      viaComponent = true;
      continue;
    }
    if (info.tokens.some((t) => /(^|:)(focus-within|has-\[:focus[\w-]*\]|has-focus[\w-]*|in-focus[\w-]*|group-focus[\w-]*)[:\w-]*:/.test(t) && !isOutlineNoneToken(t))) return { replaced: true, viaComponent };
  }
  const own = classInfo(el)?.tokens ?? [];
  // peer / group, including named ones (peer/input, group/resize).
  if (own.some((t) => /^peer(\/[\w-]+)?$/.test(t)) && el.parent) {
    for (const sib of el.parent.children) if (sib !== el && sib.type === "element" && (classInfo(sib)?.tokens ?? []).some((t) => /peer-focus/.test(t))) return { replaced: true, viaComponent };
  }
  if (own.some((t) => /^group(\/[\w-]+)?$/.test(t))) for (const d of walk(el)) if ((classInfo(d)?.tokens ?? []).some((t) => /group-focus/.test(t))) return { replaced: true, viaComponent };
  return { replaced: false, viaComponent };
}

export const focusRules: Rule[] = [
  {
    meta: {
      id: "focus-outline-removed",
      title: "Focus indicator must not be removed without a replacement",
      wcag: ["2.4.7"],
      severity: "serious",
      description: "outline: none / outline: 0 in .css, .scss, .less and <style>, or Tailwind outline-none / focus:outline-none on a focusable element, with no :focus-visible (or focus) style replacing it.",
    },
    create: (ctx) => ({
      element(el) {
        const kind = focusableKind(el);
        // Text-entry fields are left alone: the caret shows focus, and wrappers often draw the ring.
        if (!kind || kind === "text") return;
        const info = classInfo(el);
        if (!info) return;
        const removal = info.tokens.find(isOutlineNoneToken);
        if (!removal) return;
        if (info.tokens.some(isFocusReplacementToken)) return;
        const near = replacedNearby(el);
        if (near.replaced) return;
        ctx.report({
          el,
          confidence: kind === "native" && !info.partial && !near.viaComponent ? "high" : "medium",
          message: `${removal} removes the focus outline from this <${el.tag}> and no focus:/focus-visible: class (ring, outline, border, shadow) replaces it, so keyboard users cannot see when it has focus.`,
          fix: `Add a visible focus style, e.g. "focus-visible:ring-2 focus-visible:ring-offset-2" (or "focus-visible:outline-2 focus-visible:outline-offset-2"), or drop ${removal}.`,
        });
      },
    }),
  },
];
