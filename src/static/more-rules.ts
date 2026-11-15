import type { Confidence } from "../types.js";
import type { ElementNode } from "./ast.js";
import { has, isAriaHidden, isIconComponent, roleOf, sv, walk } from "./helpers.js";
import type { Rule } from "./rules.js";
import { type KnownColor, classTokens, contrastRatio, fontInfo, ownColor } from "./tailwind.js";

// ---------------------------------------------------------------------------------------------
// autocomplete-valid (1.3.5)
// ---------------------------------------------------------------------------------------------

/** HTML autofill field names (https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill). */
const AUTOFILL_FIELDS = new Set([
  "name", "honorific-prefix", "given-name", "additional-name", "family-name", "honorific-suffix", "nickname",
  "username", "new-password", "current-password", "one-time-code", "organization-title", "organization",
  "street-address", "address-line1", "address-line2", "address-line3", "address-level4", "address-level3",
  "address-level2", "address-level1", "country", "country-name", "postal-code", "cc-name", "cc-given-name",
  "cc-additional-name", "cc-family-name", "cc-number", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-csc",
  "cc-type", "transaction-currency", "transaction-amount", "language", "bday", "bday-day", "bday-month",
  "bday-year", "sex", "url", "photo",
]);
/** Fields that may follow home / work / mobile / fax / pager. */
const AUTOFILL_CONTACT = new Set([
  "tel", "tel-country-code", "tel-national", "tel-area-code", "tel-local", "tel-local-prefix", "tel-local-suffix",
  "tel-extension", "email", "impp",
]);
const ALL_FIELDS = [...AUTOFILL_FIELDS, ...AUTOFILL_CONTACT];

/** Common non-standard values and the token they mean. */
const AUTOFILL_ALIASES: Record<string, string> = {
  firstname: "given-name", "first-name": "given-name", first_name: "given-name", fname: "given-name",
  lastname: "family-name", "last-name": "family-name", last_name: "family-name", lname: "family-name", surname: "family-name",
  fullname: "name", "full-name": "name", phone: "tel", telephone: "tel", "phone-number": "tel", mobile: "tel",
  zip: "postal-code", zipcode: "postal-code", "zip-code": "postal-code", postcode: "postal-code", postalcode: "postal-code",
  password: "current-password", address: "street-address", city: "address-level2", state: "address-level1",
  birthday: "bday", "e-mail": "email", mail: "email", company: "organization", otp: "one-time-code",
};
/** Values used to switch autofill off; the valid way is autocomplete="off". */
const OFF_HACKS = /^(false|no|none|nope|disabled?|chrome-off|off-.*|.*-off|new-.*|random|null|0)$/;

/** Optimal string alignment distance (a transposition costs 1, so "emial" is 1 from "email"). */
function osa(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/** The token a misspelled or non-standard autocomplete value most likely means. */
function autofillSuggestion(bad: string): string | undefined {
  if (AUTOFILL_ALIASES[bad]) return AUTOFILL_ALIASES[bad];
  const max = bad.length <= 5 ? 1 : 2;
  let best: string | undefined;
  let bestD = Infinity;
  for (const f of ALL_FIELDS) {
    const dist = osa(bad, f);
    if (dist < bestD) [best, bestD] = [f, dist];
  }
  return bestD <= max ? best : undefined;
}

/** Returns undefined when the value is a valid autocomplete value, else the offending token. */
export function invalidAutocomplete(value: string): string | undefined {
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  if (tokens.length === 1 && (tokens[0] === "on" || tokens[0] === "off")) return undefined;
  let i = 0;
  if (tokens[i]?.startsWith("section-") && tokens[i]!.length > 8) i++;
  if (tokens[i] === "shipping" || tokens[i] === "billing") i++;
  let contactOnly = false;
  if (["home", "work", "mobile", "fax", "pager"].includes(tokens[i] ?? "")) {
    contactOnly = true;
    i++;
  }
  const field = tokens[i];
  if (!field || !(AUTOFILL_CONTACT.has(field) || (!contactOnly && AUTOFILL_FIELDS.has(field)))) return field ?? tokens[tokens.length - 1]!;
  i++;
  if (tokens[i] === "webauthn") i++;
  return i === tokens.length ? undefined : tokens[i]!;
}

// ---------------------------------------------------------------------------------------------
// label-in-name (2.5.3)
// ---------------------------------------------------------------------------------------------

const SR_ONLY = /^(sr-only|visually-hidden|visuallyhidden|screen-reader-text|screenreader|a11y-hidden|vh)$/i;

/** Visible text of an element's subtree, or undefined if any part is dynamic, a component, or responsive-hidden. */
function visibleText(el: ElementNode): string | undefined {
  let out = "";
  for (const c of el.children) {
    if (c.type === "text") {
      if (c.dynamic) return undefined;
      out += " " + c.text;
      continue;
    }
    if (c.isComponent) {
      if (isIconComponent(c)) continue;
      return undefined;
    }
    if (c.tag === "svg" || c.tag === "img" || c.tag === "template" || c.tag === "slot") {
      if (c.tag === "slot") return undefined;
      continue;
    }
    const cls = classTokens(c);
    if (!cls) return undefined;
    if (cls.some((t) => SR_ONLY.test(t))) continue;
    // `hidden md:inline`, `invisible`: visible in some layouts only.
    if (cls.some((t) => /(^|:)(hidden|invisible|collapse)$/.test(t)) || has(c, "hidden")) return undefined;
    const inner = visibleText(c);
    if (inner === undefined) return undefined;
    out += " " + inner;
  }
  return out;
}

function words(s: string): string[] {
  return s.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const LABEL_IN_NAME_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "option", "treeitem"]);

// ---------------------------------------------------------------------------------------------
// duplicate-id-ref (1.3.1, 4.1.2)
// ---------------------------------------------------------------------------------------------

/** Attributes whose value is one id (or a list of ids) of another element. */
const ID_REF_ATTRS = ["for", "aria-labelledby", "aria-describedby", "aria-controls", "aria-activedescendant", "aria-errormessage", "aria-owns", "aria-details", "aria-flowto", "headers", "list"];

/** True if this element is rendered only under a condition (it, or an ancestor, is conditional). */
function conditionallyRendered(el: ElementNode): boolean {
  for (let e: ElementNode | null = el; e; e = e.parent) if (e.conditional || (e.ifDepth ?? 0) > 0) return true;
  return false;
}

function ancestorTag(el: ElementNode, tag: string): boolean {
  for (let p = el.parent; p; p = p.parent) if (p.tag === tag) return true;
  return false;
}

function topTree(el: ElementNode): ElementNode {
  let t = el;
  while (t.parent && t.parent.parent) t = t.parent;
  return t;
}

// ---------------------------------------------------------------------------------------------
// tailwind-contrast (1.4.3)
// ---------------------------------------------------------------------------------------------

interface ColorSource {
  color: KnownColor;
  el: ElementNode;
}

/**
 * Nearest text-* (or bg-*) color on the element or its ancestors. Stops (undefined) at anything that
 * makes the color unknowable: a component boundary, bound classes, opacity, theme colors, gradients.
 */
function inheritedColor(start: ElementNode, prefix: "text" | "bg"): ColorSource | undefined {
  for (let e: ElementNode | null = start; e && e.tag !== "#root"; e = e.parent) {
    if (e.isComponent) return undefined; // a component's own markup may set colors around its children
    const tokens = classTokens(e);
    if (!tokens) return undefined;
    if (tokens.some((t) => !t.includes(":") && /^(opacity-\d+|mix-blend-.+|backdrop-.+|bg-clip-text|text-transparent)$/.test(t))) return undefined;
    const c = ownColor(tokens, prefix);
    if (c.kind === "unknown") return undefined;
    // An inline style may set the color or background.
    const style = e.attrs.get("style");
    if (style && (style.dynamic || (prefix === "bg" ? /background/i : /(^|;|\s)color\s*:/i).test(style.value ?? ""))) return undefined;
    if (c.kind === "color") return { color: c.color, el: e };
  }
  return undefined;
}

function isLargeText(el: ElementNode): boolean {
  let px: number | undefined;
  let bold: boolean | undefined;
  for (let e: ElementNode | null = el; e && e.tag !== "#root" && (px === undefined || bold === undefined); e = e.parent) {
    const f = fontInfo(classTokens(e) ?? []);
    if (px === undefined && f.px !== undefined) px = f.px;
    if (bold === undefined && f.bold !== undefined) bold = f.bold;
  }
  return px !== undefined && (px >= 24 || (px >= 18.66 && bold === true));
}

/** Has text of its own; separators and symbols alone ("·", "|", "→") are decoration, not text to read. */
function hasOwnText(el: ElementNode): boolean {
  return el.children.some((c) => c.type === "text" && (c.dynamic || /[\p{L}\p{N}]/u.test(c.text)));
}

function inactive(el: ElementNode): boolean {
  for (let e: ElementNode | null = el; e && e.tag !== "#root"; e = e.parent) {
    if (has(e, "disabled") && sv(e, "disabled") !== "false") return true;
    if (sv(e, "aria-disabled") === "true") return true;
    if (isAriaHidden(e) || e.tag === "svg") return true;
    const cls = classTokens(e);
    if (cls?.includes("sr-only")) return true;
  }
  return false;
}

export const moreRules: Rule[] = [
  {
    meta: {
      id: "autocomplete-valid",
      title: "autocomplete must use a valid value",
      wcag: ["1.3.5"],
      severity: "serious",
      description: "autocomplete on inputs must be \"on\", \"off\" or a valid HTML autofill token (email, given-name, …) so browsers and assistive tech can identify the field's purpose.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.isComponent || !["input", "select", "textarea"].includes(el.tag)) return;
        if (el.tag === "input" && ["hidden", "submit", "reset", "button", "image", "checkbox", "radio", "file", "range", "color"].includes((sv(el, "type") ?? "text").toLowerCase())) return;
        const value = sv(el, "autocomplete");
        if (value === undefined) return;
        const bad = invalidAutocomplete(value);
        if (bad === undefined) return;
        // "work name": home / work / mobile / fax / pager only qualify tel, email and impp.
        if (AUTOFILL_FIELDS.has(bad)) {
          const tokens = value.trim().toLowerCase().split(/\s+/);
          const fixed = tokens.filter((t) => !["home", "work", "mobile", "fax", "pager"].includes(t)).join(" ");
          ctx.report({
            el,
            message: `autocomplete="${value}" is invalid: home, work, mobile, fax and pager can only qualify tel, email or impp, so browsers ignore the whole value.`,
            fix: `Use autocomplete="${fixed}".`,
          });
          return;
        }
        const offHack = OFF_HACKS.test(bad);
        const suggestion = bad && !offHack ? autofillSuggestion(bad) : undefined;
        const part = bad && bad !== value.trim().toLowerCase() ? ` ("${bad}")` : "";
        ctx.report({
          el,
          severity: suggestion ? "serious" : "moderate",
          confidence: suggestion ? "high" : "medium",
          message: offHack
            ? `autocomplete="${value}" is not a valid value; browsers treat it as unknown rather than "off".`
            : `autocomplete="${value}" is not a valid autofill value${part}, so browsers cannot autofill the field and its purpose is not programmatically identified.`,
          fix: suggestion
            ? `Use autocomplete="${value.trim().toLowerCase().replace(bad, suggestion)}".`
            : offHack
              ? 'Use autocomplete="off" if the field does not collect information about the user; otherwise use its autofill token (e.g. "email", "tel").'
              : 'Use the autofill token for the data collected (e.g. "email", "given-name", "tel", "postal-code"), or autocomplete="off" if the field does not collect information about the user.',
        });
      },
    }),
  },
  {
    meta: {
      id: "label-in-name",
      title: "Accessible name must contain the visible label",
      wcag: ["2.5.3"],
      severity: "serious",
      description: "When aria-label replaces the visible text of a control, it must contain that text, so voice-control users can say what they see.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.isComponent || el.hasSpread) return;
        const role = roleOf(el);
        const isControl = el.tag === "button" || (el.tag === "a" && has(el, "href")) || (role !== undefined && LABEL_IN_NAME_ROLES.has(role));
        const isInputButton = el.tag === "input" && ["submit", "button", "reset"].includes((sv(el, "type") ?? "").toLowerCase());
        if (!isControl && !isInputButton) return;
        if (has(el, "aria-labelledby") || isAriaHidden(el)) return;
        const label = sv(el, "aria-label");
        if (!label?.trim()) return;
        const text = isInputButton ? sv(el, "value") : visibleText(el);
        if (text === undefined) return;
        const visible = words(text);
        // Symbols and single characters ("×", "+", "1") are not a speakable label.
        if (visible.join("").length < 2) return;
        const name = words(label);
        if (` ${name.join(" ")} `.includes(` ${visible.join(" ")} `)) return;
        // aria-label is the visible heading of a larger control ("Ask AI" + a description line): the
        // spoken visible label still matches.
        if (` ${visible.join(" ")} `.includes(` ${name.join(" ")} `)) return;
        // All words present but split or reordered ("Add to cart" vs "Add Blue Shirt to cart"): weaker evidence.
        const allWords = visible.every((w) => name.includes(w));
        const full = text.replace(/\s+/g, " ").trim();
        const shown = full.length > 60 ? full.slice(0, 59) + "…" : full;
        ctx.report({
          el,
          confidence: allWords ? "medium" : "high",
          severity: allWords ? "moderate" : "serious",
          message: `Visible label "${shown}" is not part of the accessible name "${label}", so voice-control users saying "click ${shown}" may not reach it.`,
          fix: `Make the aria-label start with the visible text (e.g. aria-label="${shown} …"), or remove aria-label so the visible text is the name.`,
        });
      },
    }),
  },
  {
    meta: {
      id: "table-headers",
      title: "Data tables must have header cells",
      wcag: ["1.3.1"],
      severity: "serious",
      description: "Tables of data need <th> (with scope where needed) so screen readers can announce each cell's row and column headers.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "table" || el.hasSpread || isAriaHidden(el)) return;
        const role = roleOf(el);
        if (role === "presentation" || role === "none") return;
        // Nested tables are a layout-table pattern (old HTML, emails); skip both levels.
        if ([...walk(el)].some((d) => d.tag === "table") || ancestorTag(el, "table")) return;
        const rows: ElementNode[] = [];
        let thead: ElementNode | undefined;
        let caption = false;
        // Walk the table's own structure (not nested tables). Rows rendered by components or helpers are unknown.
        const visit = (node: ElementNode, depth: number): boolean => {
          for (const c of node.children) {
            if (c.type === "text") {
              if (c.dynamic && depth < 3 && c.expr !== undefined && !/=>|\bmap\(/.test(c.expr)) return false;
              continue;
            }
            if (c.isComponent || c.tag === "slot" || c.tag === "template") return false;
            if (c.tag === "table") return false; // layout tables nest; skip
            if (c.tag === "caption") caption = true;
            if (c.tag === "thead") thead = c;
            if (c.tag === "tr") rows.push(c);
            if (["thead", "tbody", "tfoot", "tr"].includes(c.tag) && !visit(c, depth + 1)) return false;
          }
          return true;
        };
        if (!visit(el, 0)) return;
        const cells = rows.flatMap((r) => r.children.filter((c): c is ElementNode => c.type === "element"));
        if (cells.some((c) => c.isComponent || (c.tag !== "td" && c.tag !== "th"))) return;
        if (cells.some((c) => c.tag === "th" || has(c, "scope") || ["columnheader", "rowheader"].includes(roleOf(c) ?? "") || has(c, "headers"))) return;
        const headRow = thead !== undefined && cells.some((c) => c.parent?.parent === thead);
        const maxCols = Math.max(0, ...rows.map((r) => r.children.filter((c) => c.type === "element").length));
        if (!headRow && !(rows.length >= 2 && maxCols >= 2)) return;
        const confidence: Confidence = headRow || caption ? "high" : "medium";
        ctx.report({
          el,
          confidence,
          message: headRow
            ? "The table's header row uses <td>, so screen readers don't announce column headers when reading cells."
            : "Table has rows and columns of data but no header cells (<th>), so cells are read without their row or column headers.",
          fix: headRow
            ? 'Change the header row\'s <td> to <th scope="col">.'
            : 'Mark header cells with <th scope="col"> (column headers) or <th scope="row"> (row headers). If the table is only for layout, add role="presentation".',
        });
      },
    }),
  },
  {
    meta: {
      id: "duplicate-id-ref",
      title: "IDs used by labels and ARIA references must be unique",
      wcag: ["1.3.1", "4.1.2"],
      severity: "serious",
      description: "When two elements share an id that a <label for>, aria-labelledby, aria-describedby or other reference points to, the reference reaches only the first one.",
    },
    create: (ctx) => {
      const byId = new Map<string, ElementNode[]>();
      const refs = new Map<string, ElementNode[]>();
      return {
        element(el) {
          if (ctx.doc.framework === "html") for (let p = el.parent; p; p = p.parent) if (p.tag === "template") return;
          const id = sv(el, "id")?.trim();
          if (id) byId.set(id, [...(byId.get(id) ?? []), el]);
          for (const name of ID_REF_ATTRS) {
            const v = sv(el, name);
            if (!v) continue;
            if (name === "for" && el.tag !== "label" && el.tag !== "output") continue;
            for (const ref of v.trim().split(/\s+/)) refs.set(ref, [...(refs.get(ref) ?? []), el]);
          }
        },
        done() {
          for (const [id, els] of byId) {
            if (els.length < 2 || !refs.has(id)) continue;
            // Only elements that render together: same JSX tree, none behind a condition (v-if / v-else, {cond && …}).
            const always = els.filter((e) => !conditionallyRendered(e));
            const groups = new Map<ElementNode, ElementNode[]>();
            for (const e of always) {
              const key = ctx.doc.framework === "jsx" ? topTree(e) : ctx.doc.root;
              groups.set(key, [...(groups.get(key) ?? []), e]);
            }
            for (const group of groups.values()) {
              if (group.length < 2) continue;
              const referrer = refs.get(id)!.find((r) => ctx.doc.framework !== "jsx" || topTree(r) === topTree(group[0]!));
              if (!referrer) continue;
              const how = referrer.tag === "label" && has(referrer, "for") ? `<label for="${id}">` : `${ID_REF_ATTRS.find((a) => (sv(referrer, a) ?? "").split(/\s+/).includes(id))}="${id}" (line ${referrer.line})`;
              for (const dup of group.slice(1)) {
                ctx.report({
                  el: dup,
                  message: `id="${id}" is also used on line ${group[0]!.line}; ${how} only reaches the first element, so this <${dup.tag}> loses its label or relationship.`,
                  fix: `Give each element a unique id (e.g. from useId() or a prefix), and point the label / aria-* reference at the right one.`,
                });
              }
            }
          }
        },
      };
    },
  },
  {
    meta: {
      id: "tailwind-contrast",
      title: "Text must have sufficient contrast (Tailwind classes)",
      wcag: ["1.4.3"],
      severity: "serious",
      description: "text-* on bg-* Tailwind classes whose default-palette colors are below 4.5:1 (3:1 for large text). Only reported when both colors are known statically.",
    },
    create: (ctx) => {
      const reported = new Set<string>();
      return {
        element(el) {
          if (el.isComponent || !hasOwnText(el) || inactive(el)) return;
          const fg = inheritedColor(el, "text");
          if (!fg) return;
          const bg = inheritedColor(el, "bg");
          if (!bg) return;
          const large = isLargeText(el);
          const need = large ? 3 : 4.5;
          const v4 = contrastRatio(fg.color.v4, bg.color.v4);
          // Fails under both palette versions (v3 hex / v4 OKLCH), so the result does not depend on the Tailwind version.
          const v3 = fg.color.v3 && bg.color.v3 ? contrastRatio(fg.color.v3, bg.color.v3) : v4;
          const ratio = Math.max(v3, v4);
          if (ratio >= need) return;
          const target = fg.el;
          const key = `${target.line}:${target.column}|${bg.el.line}:${bg.el.column}`;
          if (reported.has(key)) return;
          reported.add(key);
          const where = bg.el === target ? "" : ` (background set on <${bg.el.tag}> at line ${bg.el.line})`;
          ctx.report({
            el: target,
            confidence: "medium",
            message: `${fg.color.token} on ${bg.color.token} has a contrast ratio of about ${ratio.toFixed(2)}:1${fg.color.token.includes("[") && bg.color.token.includes("[") ? "" : " with Tailwind's default palette"}${where}; ${large ? "large " : ""}text needs at least ${need}:1.`,
            fix: `Use a ${darkBg(bg.color) ? "lighter" : "darker"} text color${suggest(fg.color.token, darkBg(bg.color))} or adjust the background, and re-check the ratio. If the project overrides this palette color, verify in the browser instead.`,
          });
        },
      };
    },
  },
];

function darkBg(c: KnownColor): boolean {
  return contrastRatio(c.v4, "#000000") < contrastRatio(c.v4, "#ffffff");
}

/** e.g. text-gray-400 on white → " (e.g. text-gray-600)". Only for palette colors. */
function suggest(token: string, lighter: boolean): string {
  const m = /^text-([a-z]+)-(\d+)$/.exec(token);
  if (!m) return "";
  const order = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"];
  const i = order.indexOf(m[2]!);
  const j = lighter ? Math.max(0, i - 2) : Math.min(order.length - 1, i + 2);
  return j === i ? "" : ` (e.g. text-${m[1]}-${order[j]})`;
}
