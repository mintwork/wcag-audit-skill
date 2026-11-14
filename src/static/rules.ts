import type { Confidence, Severity } from "../types.js";
import { ARIA_ATTRIBUTES, ARIA_ROLES, INTERACTIVE_ROLES, NATIVE_INTERACTIVE, NON_INTERACTIVE_CONTAINERS, closest } from "./aria.js";
import type { ElementNode, ParsedDocument } from "./ast.js";
import { LABEL_WRAPPER, designSystemInput, designSystemInputLabelled, thinControl } from "./form-components.js";
import type { Tri } from "./helpers.js";
import {
  accessibleName,
  ancestor,
  attr,
  containsIconComponent,
  containsNativeControl,
  has,
  hasClickHandler,
  hasKeyHandler,
  isAriaHidden,
  isDynamic,
  isIconComponent,
  isNativelyFocusable,
  nameFromAttrs,
  nameFromContent,
  onlyStopsPropagation,
  receivesInjectedInteraction,
  roleOf,
  sv,
  tabIndexValue,
  walk,
} from "./helpers.js";

export interface RuleMeta {
  id: string;
  title: string;
  wcag: string[];
  severity: Severity;
  /** One-line description for docs and SARIF. */
  description: string;
}

export interface Report {
  el: ElementNode;
  message: string;
  fix: string;
  confidence?: Confidence;
  severity?: Severity;
}

/** Where a component is defined: its top-level JSX trees, and the file (undefined = this file). */
export interface ResolvedComponent {
  trees: ElementNode[];
  file: string | undefined;
  doc: ParsedDocument;
}

export interface RuleContext {
  doc: ParsedDocument;
  /** The definition of a component used in this file (same file, or imported when a resolver is available). */
  resolveComponent?(el: ElementNode): ResolvedComponent | undefined;
  /** Every static `for`/`htmlFor` value on <label> in this file. */
  labelTargets: Set<string>;
  /** Some <label for> in this file is bound to an expression. */
  hasDynamicLabelTarget: boolean;
  report(r: Report): void;
}

export interface Rule {
  meta: RuleMeta;
  create(ctx: RuleContext): { element?(el: ElementNode): void; done?(): void };
}

const INPUT_TYPES_WITHOUT_LABEL = new Set(["hidden", "submit", "reset", "button", "image"]);
const VAGUE_ALT = /^(image|img|photo|picture|graphic|icon|logo|banner|spacer|untitled|placeholder|screenshot|\s*)$/i;
const FILENAME_ALT = /\.(png|jpe?g|gif|svg|webp|avif|bmp)$/i;
// Not "go": it is far more often the language or a product name ("Go", "Go modules") than a vague verb.
const VAGUE_LINK = /^(click here|here|read more|more|learn more|link|this)\.?$/i;
/** Button components (<Button>, <IconButton>, <Mui.IconButton>) are buttons in every UI library we know. */
const BUTTON_COMPONENT = /^(Icon)?Button$/;
/** Props through which a button component may receive its accessible name. */
const NAME_PROP = /^(aria-label|aria-labelledby|title|label|tooltip|text|alt|name|description|sr-?text|screenreadertext|accessibilitylabel|asChild|aschild|render|as|component)$/i;

/** <IconButton><CloseIcon /></IconButton>: a button component whose only children are icons, with no name prop. */
function isIconOnlyButtonComponent(el: ElementNode): boolean {
  if (!el.isComponent || !BUTTON_COMPONENT.test(el.tag.split(".").pop() ?? "") || el.hasSpread) return false;
  if ([...el.attrs.keys()].some((k) => NAME_PROP.test(k))) return false;
  const kids = el.children;
  if (!kids.length) return false;
  for (const c of kids) {
    if (c.type === "text") return false; // text, or an expression that may render text
    if (isAriaHidden(c)) continue;
    if (isIconComponent(c)) {
      if (nameFromAttrs(c) !== "no" || has(c, "label") || has(c, "title") || has(c, "alt")) return false;
      continue;
    }
    if (c.tag === "svg" && accessibleName(c) === "no") continue;
    return false;
  }
  return true;
}

/** Server-side template placeholders that inject <title> and other head tags at render time. */
const HEAD_PLACEHOLDER = /%[\w.-]*head[\w.-]*%|<!--\s*[\w-]*head[\w-]*\s*-->|<%|\{\{|\{%|<\?/i;

/** True if a bound type expression can only produce text-like input types, e.g. show ? 'text' : 'password'. */
function onlyLabelableTypes(expr: string | undefined): boolean {
  if (!expr) return false;
  const literals = [...expr.matchAll(/(["'`])([a-z-]*)\1/g)].map((m) => m[2]!);
  const rest = expr.replace(/(["'`])[a-z-]*\1/g, "").replace(/[\w$.?:!=&|()\s]/g, "");
  return literals.length >= 2 && rest === "" && literals.every((t) => !INPUT_TYPES_WITHOUT_LABEL.has(t) && t !== "");
}

/** Labels that wrap a button (or point at it with for=) name it: <label>Back <button><Icon/></button></label>. */
function labelledByLabel(ctx: RuleContext, el: ElementNode): Tri {
  const id = sv(el, "id");
  if (id && ctx.labelTargets.has(id)) return "yes";
  const wrap = ancestor(el, (p) => p.tag === "label");
  if (!wrap) return "no";
  // The label's own text (excluding the button's subtree) names the button.
  let result: Tri = "no";
  for (const c of wrap.children) {
    if (c === el) continue;
    if (c.type === "text") {
      if (c.dynamic) result = "unknown";
      else if (c.text.trim()) return "yes";
      continue;
    }
    if (walkContains(c, el)) continue;
    const n = accessibleName(c);
    if (n === "yes") return "yes";
    if (n === "unknown") result = "unknown";
  }
  return result;
}

function walkContains(root: ElementNode, target: ElementNode): boolean {
  for (let e: ElementNode | null = target; e; e = e.parent) if (e === root) return true;
  return false;
}

/**
 * For a form control inside <Field>/<FormLabel>-style wrapper defined in this same file: does that
 * wrapper associate its <label> with the control? "no" only when we can see every <label> it renders
 * and none has for/htmlFor or wraps {children}.
 */
function wrapperAssociatesLabel(ctx: RuleContext, wrapper: ElementNode): Tri {
  const defs = (ctx.resolveComponent?.(wrapper) ?? (ctx.doc.components?.get(wrapper.tag) ? { trees: ctx.doc.components.get(wrapper.tag)! } : undefined))?.trees;
  if (!defs?.length) return "unknown";
  const labels: ElementNode[] = [];
  let rendersChildren = false;
  for (const d of defs) {
    for (const e of [d, ...walk(d)]) {
      if (e.tag === "label") labels.push(e);
      // The real <label> may come from another component (<FormLabel>, <Label {...props}>).
      if (e.isComponent && e.tag !== wrapper.tag && /label|field|control|form/i.test(e.tag)) return "unknown";
      if (e.children.some((c) => c.type === "text" && c.dynamic && /\bchildren\b/.test(c.expr ?? ""))) rendersChildren = true;
    }
  }
  if (!labels.length || !rendersChildren) return "unknown";
  for (const l of labels) {
    if (l.hasSpread || has(l, "for")) return "unknown";
    if (l.children.some((c) => c.type === "text" && c.dynamic && /\bchildren\b/.test(c.expr ?? ""))) return "unknown";
    for (const e of walk(l)) if (e.children.some((c) => c.type === "text" && c.dynamic && /\bchildren\b/.test(c.expr ?? ""))) return "unknown";
  }
  return "no";
}

/**
 * Plain HTML elements that are empty but carry an id / data-* hook are often filled by script.
 * Keep reporting them (most are real), but at medium confidence so verification checks the runtime.
 */
function emptyContentConfidence(ctx: RuleContext, el: ElementNode, base: Confidence = "high"): Confidence {
  if (ctx.doc.framework !== "html") return base;
  const scripted = has(el, "id") || [...el.attrs.keys()].some((k) => k.startsWith("data-"));
  return scripted ? "medium" : base;
}

export const rules: Rule[] = [
  {
    meta: {
      id: "img-alt",
      title: "Images must have alternative text",
      wcag: ["1.1.1"],
      severity: "critical",
      description: "<img> elements need an alt attribute (alt=\"\" for decorative images).",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "img") return;
        if (has(el, "alt") || el.hasSpread) return;
        if (["presentation", "none"].includes(roleOf(el) ?? "")) return;
        if (isAriaHidden(el)) return;
        if (nameFromAttrs(el) !== "no") return;
        ctx.report({
          el,
          message: "Image has no alt attribute, so screen readers announce the file name or nothing at all.",
          fix: 'Add alt="<what the image conveys>" — or alt="" if the image is purely decorative.',
        });
      },
    }),
  },
  {
    meta: {
      id: "img-alt-meaningful",
      title: "Alternative text must describe the image",
      wcag: ["1.1.1"],
      severity: "minor",
      description: "alt text such as \"image\", \"photo\" or a file name gives no information.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "img") return;
        const alt = sv(el, "alt");
        if (alt === undefined || alt === "") return;
        if (VAGUE_ALT.test(alt) || FILENAME_ALT.test(alt.trim())) {
          ctx.report({
            el,
            message: `alt="${alt}" does not describe the image's content or purpose.`,
            fix: "Describe what the image communicates in context (e.g. alt=\"Bar chart: revenue doubled in Q3\"), or use alt=\"\" if decorative.",
            confidence: "medium",
          });
        }
      },
    }),
  },
  {
    meta: {
      id: "input-image-alt",
      title: "Image buttons must have alternative text",
      wcag: ["1.1.1", "4.1.2"],
      severity: "critical",
      description: "<input type=\"image\"> needs alt text that describes the action.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "input" || sv(el, "type") !== "image") return;
        if (has(el, "alt") || nameFromAttrs(el) !== "no") return;
        ctx.report({
          el,
          message: "Image button has no alt text, so its action is unknown to assistive technology.",
          fix: 'Add alt describing the action, e.g. alt="Search".',
        });
      },
    }),
  },
  {
    meta: {
      id: "svg-img-name",
      title: "SVGs with role=img must have an accessible name",
      wcag: ["1.1.1"],
      severity: "serious",
      description: "<svg role=\"img\"> needs a <title> child or aria-label.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "svg" || roleOf(el) !== "img") return;
        if (accessibleName(el) !== "no") return;
        ctx.report({
          el,
          message: "SVG is exposed as an image but has no name.",
          fix: 'Add aria-label="…" or a <title> as the first child. If it is decorative, use aria-hidden="true" instead of role="img".',
        });
      },
    }),
  },
  {
    meta: {
      id: "form-label",
      title: "Form controls must have labels",
      wcag: ["1.3.1", "3.3.2", "4.1.2"],
      severity: "critical",
      description: "Inputs, selects and textareas need a <label>, aria-label or aria-labelledby. Placeholder is not a label.",
    },
    create: (ctx) => ({
      element(el) {
        let tag = el.tag;
        /** Set when a project component (<Input>) renders the control: report at medium confidence, naming it. */
        let thin: ReturnType<typeof thinControl>;
        if (el.isComponent) {
          const ds = designSystemInput(ctx, el);
          if (ds) {
            if (designSystemInputLabelled(ctx, el, ds)) return;
            ctx.report({
              el,
              confidence: "medium",
              message: `<${el.tag}> (${ds.pkg}) has no label${has(el, "placeholder") ? " (a placeholder is not a label)" : ""}, so the input it renders is announced without a name.`,
              fix: ds.fix,
            });
            return;
          }
          thin = thinControl(ctx, el);
          if (!thin) return;
          tag = thin.tag;
        } else if (!["input", "select", "textarea"].includes(el.tag)) return;
        if (el.hasSpread) return;
        if (tag === "input") {
          const type = attr(el, "type");
          // type={show ? "text" : "password"}: fine to check when every possible value needs a label.
          if (type?.dynamic && !onlyLabelableTypes(type.expr)) return;
          if (INPUT_TYPES_WITHOUT_LABEL.has((type?.value ?? thin?.type ?? "text").toLowerCase())) return;
        }
        if (isAriaHidden(el)) return;
        if (nameFromAttrs(el) !== "no") return;
        const wrapper = ancestor(el, (p) => p.tag === "label" || (p.isComponent && LABEL_WRAPPER.test(p.tag)));
        let viaWrapper = false;
        if (wrapper) {
          if (wrapper.tag === "label" || wrapperAssociatesLabel(ctx, wrapper) !== "no") return;
          viaWrapper = true;
        }
        const id = attr(el, "id");
        if (id?.dynamic && (ctx.hasDynamicLabelTarget || ctx.labelTargets.size > 0)) return;
        if (id?.value && ctx.labelTargets.has(id.value)) return;
        if (id?.value && ctx.hasDynamicLabelTarget) return;
        const placeholder = has(el, "placeholder");
        const orphanLabel = el.parent?.children.some(
          (c) => c.type === "element" && c.tag === "label" && !has(c, "for") && ![...walk(c)].some((d) => d.isComponent || ["input", "select", "textarea"].includes(d.tag)),
        );
        if (viaWrapper) {
          const where = ctx.resolveComponent?.(wrapper!)?.file;
          ctx.report({
            el,
            confidence: "medium",
            message: `<${wrapper!.tag}> (defined in ${where ?? "this file"}) renders a <label> that is neither wrapping this control nor pointing at it with for/htmlFor, so the control has no programmatic label.`,
            fix: `In <${wrapper!.tag}>, give the control an id (e.g. from useId()) and render <label htmlFor={id}>, or wrap {children} inside the <label>. Or add aria-label here.`,
          });
          return;
        }
        ctx.report({
          el,
          ...(thin ? { confidence: "medium" as const } : {}),
          message: (thin ? `<${el.tag}> renders an <${tag}> (defined in ${thin.file ?? "this file"}) and gets no label here. ` : "") + (orphanLabel
            ? "A <label> sits next to this control but is not associated with it (no for/htmlFor), so screen readers announce an unlabeled field."
            : placeholder
              ? "Control relies on placeholder text, which disappears on input and is not a reliable label."
              : "Form control has no programmatic label."),
          fix: id?.value
            ? `Add <label for="${id.value}">…</label>, or aria-label="…".`
            : 'Wrap it in <label>Text <input …></label>, or give it an id and add <label for="that-id">, or aria-label="…".',
        });
      },
    }),
  },
  {
    meta: {
      id: "button-name",
      title: "Buttons must have discernible text",
      wcag: ["4.1.2"],
      severity: "critical",
      description: "Buttons (including icon-only buttons) need text content, aria-label or aria-labelledby.",
    },
    create: (ctx) => ({
      element(el) {
        if (isIconOnlyButtonComponent(el)) {
          ctx.report({
            el,
            confidence: "medium",
            message: `<${el.tag}> contains only an icon and no text or aria-label, so it is likely announced as just "button".`,
            fix: `Add aria-label="<action>" to <${el.tag}> (or visually hidden text inside it), and aria-hidden="true" on the icon.`,
          });
          return;
        }
        const isButton = el.tag === "button" || (!el.isComponent && roleOf(el) === "button");
        const isInputButton = el.tag === "input" && sv(el, "type") === "button";
        if (!isButton && !isInputButton) return;
        if (isAriaHidden(el)) return;
        if (isInputButton) {
          if (has(el, "value") || nameFromAttrs(el) !== "no") return;
        } else if (accessibleName(el) !== "no") return;
        if (labelledByLabel(ctx, el) !== "no") return;
        ctx.report({
          el,
          message: "Button has no accessible name; screen readers announce only \"button\".",
          confidence: emptyContentConfidence(ctx, el, containsIconComponent(el) ? "medium" : "high"),
          fix: 'Add visible text, or aria-label="<action>" for icon-only buttons (and aria-hidden="true" on the icon).',
        });
      },
    }),
  },
  {
    meta: {
      id: "link-name",
      title: "Links must have discernible text",
      wcag: ["2.4.4", "4.1.2"],
      severity: "serious",
      description: "Links need text content, an image with alt, or aria-label.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "a" || !has(el, "href")) return;
        if (isAriaHidden(el)) return;
        if (accessibleName(el) !== "no") return;
        ctx.report({
          el,
          message: "Link has no accessible name, so its destination is unknown.",
          confidence: emptyContentConfidence(ctx, el, containsIconComponent(el) ? "medium" : "high"),
          fix: 'Add link text, or aria-label="<destination>" for icon links.',
        });
      },
    }),
  },
  {
    meta: {
      id: "link-text-vague",
      title: "Link text should describe its purpose",
      wcag: ["2.4.4"],
      severity: "minor",
      description: "Text like \"click here\" or \"read more\" is meaningless out of context.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "a" || nameFromAttrs(el) !== "no") return;
        const kids = el.children;
        if (kids.length !== 1 || kids[0]!.type !== "text" || kids[0]!.dynamic) return;
        const text = kids[0]!.text.trim();
        if (!VAGUE_LINK.test(text)) return;
        ctx.report({
          el,
          message: `Link text "${text}" does not say where it goes.`,
          fix: 'Use descriptive text ("Read the pricing guide") or add aria-label with the full purpose.',
          confidence: "medium",
        });
      },
    }),
  },
  {
    meta: {
      id: "no-div-button",
      title: "Clickable non-interactive elements must be real controls",
      wcag: ["2.1.1", "4.1.2"],
      severity: "critical",
      description: "<div onClick> is invisible to keyboards and screen readers. Use <button> (or <a href>).",
    },
    create: (ctx) => ({
      element(el) {
        if (el.isComponent || !NON_INTERACTIVE_CONTAINERS.has(el.tag)) return;
        if (!hasClickHandler(el)) return;
        if (has(el, "role") || isAriaHidden(el)) return;
        if (el.hasSpread || receivesInjectedInteraction(el)) return;
        // e.g. <div class="dialog" @click.stop>: the handler only keeps clicks from reaching a backdrop.
        if (onlyStopsPropagation(el)) return;
        // <li onClick={run}><button>Run</button></li>: keyboard activation of the inner control bubbles here.
        // Only for click handlers (not drag/pointer gestures), and only for controls that are always rendered.
        if (has(el, "onclick") && containsNativeControl(el)) return;
        const focusable = tabIndexValue(el) !== undefined && tabIndexValue(el)! >= 0;
        ctx.report({
          el,
          message: `<${el.tag}> has a click handler but no role${focusable ? "" : ", is not focusable,"} and no keyboard support.`,
          fix: `Replace <${el.tag}> with <button type="button"> (keeps the handler, gains focus, Enter/Space and role for free). For navigation use <a href>.`,
        });
      },
    }),
  },
  {
    meta: {
      id: "interactive-role-keyboard",
      title: "Custom widgets must be focusable and keyboard operable",
      wcag: ["2.1.1"],
      severity: "serious",
      description: "Elements with an interactive role need tabindex=\"0\" and key handlers.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.isComponent || NATIVE_INTERACTIVE.has(el.tag)) return;
        const role = roleOf(el);
        if (!role || !INTERACTIVE_ROLES.has(role)) return;
        if (el.hasSpread || isAriaHidden(el) || sv(el, "aria-disabled") === "true") return;
        if (receivesInjectedInteraction(el)) return;
        const tab = attr(el, "tabindex");
        const notFocusable = !tab;
        const noKeys = hasClickHandler(el) && !hasKeyHandler(el);
        if (!notFocusable && !noKeys) return;
        const problems = [notFocusable && "it is not focusable (no tabindex)", noKeys && "it handles clicks but not keys"].filter(Boolean);
        ctx.report({
          el,
          message: `role="${role}" on <${el.tag}> but ${problems.join(" and ")}.`,
          fix:
            role === "button"
              ? 'Prefer a native <button type="button">. Otherwise add tabindex="0" and an onKeyDown handler for Enter and Space.'
              : 'Add tabindex="0" (or roving tabindex) and keyboard handlers that match the ARIA Authoring Practices pattern for this role.',
        });
      },
    }),
  },
  {
    meta: {
      id: "anchor-is-button",
      title: "Links without a real destination should be buttons",
      wcag: ["2.1.1", "4.1.2"],
      severity: "serious",
      description: "<a onClick> with no href, href=\"#\" or javascript: is not keyboard accessible or announced correctly.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "a" || !hasClickHandler(el) || el.hasSpread || has(el, "role")) return;
        const href = attr(el, "href");
        if (href?.dynamic) return;
        const v = href?.value?.trim();
        if (href && v && v !== "#" && !/^javascript:/i.test(v)) return;
        ctx.report({
          el,
          severity: href ? "serious" : "critical",
          message: href
            ? `Link with href="${v ?? ""}" is used as a button.`
            : "Anchor without href is not focusable, so keyboard users cannot activate it.",
          fix: 'Use <button type="button"> for actions; keep <a href="/real-url"> for navigation.',
        });
      },
    }),
  },
  {
    meta: {
      id: "heading-order",
      title: "Heading levels should only increase by one",
      wcag: ["1.3.1"],
      severity: "moderate",
      description: "Skipping heading levels (h1 → h3) breaks the document outline screen-reader users navigate by.",
    },
    create: (ctx) => {
      let prev = 0;
      let tree: ElementNode | undefined;
      return {
        element(el) {
          // JSX files hold many separately rendered trees (one per component / return). Compare headings
          // only within one tree, so <h1> in <Page> and <h3> in <Card> are not read as a skipped level.
          if (ctx.doc.framework === "jsx") {
            let top = el;
            while (top.parent && top.parent.parent) top = top.parent;
            if (top !== tree) {
              tree = top;
              prev = 0;
            }
          }
          let level = 0;
          const m = /^h([1-6])$/.exec(el.tag);
          if (m) level = Number(m[1]);
          else if (roleOf(el) === "heading") level = Number(sv(el, "aria-level") ?? 2);
          if (!level) return;
          if (prev && level > prev + 1) {
            ctx.report({
              el,
              message: `Heading level jumps from h${prev} to h${level}.`,
              fix: `Use <h${prev + 1}> here (style it with CSS if it should look smaller), or restructure the outline.`,
              confidence: "medium",
            });
          }
          prev = level;
        },
      };
    },
  },
  {
    meta: {
      id: "empty-heading",
      title: "Headings must have content",
      wcag: ["1.3.1", "2.4.6"],
      severity: "serious",
      description: "Empty headings appear in the headings list as blank entries.",
    },
    create: (ctx) => ({
      element(el) {
        if (!/^h[1-6]$/.test(el.tag) || isAriaHidden(el)) return;
        if (accessibleName(el) !== "no") return;
        ctx.report({
          el,
          message: "Heading is empty.",
          fix: "Add text to the heading, or remove it if it is only used for spacing.",
          confidence: emptyContentConfidence(ctx, el),
        });
      },
    }),
  },
  {
    meta: {
      id: "html-lang",
      title: "<html> must have a valid lang attribute",
      wcag: ["3.1.1"],
      severity: "serious",
      description: "Screen readers use lang to pick pronunciation rules.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "html") return;
        const lang = attr(el, "lang") ?? attr(el, "xml:lang");
        if (lang?.dynamic || el.hasSpread) return;
        if (!lang || !lang.value?.trim()) {
          ctx.report({ el, message: "Page has no language set.", fix: 'Add lang to <html>, e.g. <html lang="en">.' });
        } else if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(lang.value.trim())) {
          ctx.report({ el, message: `lang="${lang.value}" is not a valid BCP 47 language tag.`, fix: 'Use a valid tag such as "en", "en-US", "fr" or "pt-BR".' });
        }
      },
    }),
  },
  {
    meta: {
      id: "document-title",
      title: "Pages must have a <title>",
      wcag: ["2.4.2"],
      severity: "serious",
      description: "The title is the first thing announced and identifies the tab.",
    },
    create: (ctx) => {
      let html: ElementNode | undefined;
      return {
        element(el) {
          if (el.tag === "html") html = el;
        },
        done() {
          if (!html || ctx.doc.framework !== "html") return;
          const head = [...walk(html)].find((e) => e.tag === "head");
          const headSrc = head ? ctx.doc.source.slice(ctx.doc.source.indexOf(head.openTag), ctx.doc.source.search(/<\/head\s*>/i)) : ctx.doc.source;
          // %sveltekit.head%, <!--app-head-->, <%= htmlWebpackPlugin.options.title %>: the title is injected at build/render time.
          if (HEAD_PLACEHOLDER.test(headSrc)) return;
          for (const e of walk(html)) {
            if (e.tag === "title") {
              if (nameFromContent(e) !== "no") return;
              ctx.report({ el: e, message: "<title> is empty.", fix: "Give the page a descriptive, unique title." });
              return;
            }
          }
          ctx.report({ el: html, message: "Document has no <title>.", fix: "Add <title>Page name – Site name</title> inside <head>." });
        },
      };
    },
  },
  {
    meta: {
      id: "no-positive-tabindex",
      title: "Avoid positive tabindex",
      wcag: ["2.4.3"],
      severity: "serious",
      description: "tabindex > 0 overrides the natural focus order and almost always produces a confusing sequence.",
    },
    create: (ctx) => ({
      element(el) {
        const t = tabIndexValue(el);
        if (t === undefined || t <= 0) return;
        ctx.report({
          el,
          message: `tabindex="${t}" forces this element ahead of the natural focus order.`,
          fix: 'Use tabindex="0" (or remove it for native controls) and order the DOM to match the visual order.',
        });
      },
    }),
  },
  {
    meta: {
      id: "iframe-title",
      title: "Frames must have a title",
      wcag: ["4.1.2"],
      severity: "serious",
      description: "<iframe> needs a title describing its content.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "iframe" || isAriaHidden(el)) return;
        if (nameFromAttrs(el) !== "no") return;
        ctx.report({ el, message: "iframe has no title.", fix: 'Add title="<what the frame contains>", e.g. title="Product demo video".' });
      },
    }),
  },
  {
    meta: {
      id: "aria-hidden-focusable",
      title: "aria-hidden elements must not be focusable",
      wcag: ["4.1.2"],
      severity: "serious",
      description: "Focusable content inside aria-hidden=\"true\" is reachable by keyboard but silent to screen readers.",
    },
    create: (ctx) => ({
      element(el) {
        if (sv(el, "aria-hidden") !== "true") return;
        const candidates = [el, ...walk(el)];
        for (const c of candidates) {
          const t = tabIndexValue(c);
          if (t !== undefined && t < 0) continue;
          if (isNativelyFocusable(c) || (t !== undefined && t >= 0)) {
            ctx.report({
              el: c,
              message: c === el ? "Element is aria-hidden but focusable." : `Focusable <${c.tag}> inside an aria-hidden="true" container.`,
              fix: 'Remove aria-hidden, or make the content inert (the inert attribute, or tabindex="-1" on each control).',
            });
            return;
          }
        }
      },
    }),
  },
  {
    meta: {
      id: "aria-role-valid",
      title: "ARIA roles must be valid",
      wcag: ["4.1.2"],
      severity: "serious",
      description: "Unknown role values are ignored by assistive technology.",
    },
    create: (ctx) => ({
      element(el) {
        const role = sv(el, "role");
        if (!role) return;
        const tokens = role.trim().split(/\s+/);
        const bad = tokens.filter((r) => !ARIA_ROLES.has(r.toLowerCase()));
        // A fallback list ("switch checkbox") with at least one valid role is allowed.
        if (!bad.length || bad.length < tokens.length) return;
        const suggestion = closest(bad[0]!.toLowerCase(), ARIA_ROLES);
        ctx.report({
          el,
          message: `role="${role}" is not a WAI-ARIA role.`,
          fix: suggestion ? `Did you mean role="${suggestion}"? Prefer a native element where one exists.` : "Use a valid WAI-ARIA role, or a native element.",
        });
      },
    }),
  },
  {
    meta: {
      id: "aria-attr-valid",
      title: "ARIA attributes must be valid",
      wcag: ["4.1.2"],
      severity: "serious",
      description: "Misspelled aria-* attributes (aria-lable) silently do nothing.",
    },
    create: (ctx) => ({
      element(el) {
        for (const name of el.attrs.keys()) {
          if (!name.startsWith("aria-") || ARIA_ATTRIBUTES.has(name)) continue;
          const suggestion = closest(name, ARIA_ATTRIBUTES);
          ctx.report({
            el,
            message: `${name} is not an ARIA attribute.`,
            fix: suggestion ? `Rename to ${suggestion}.` : "Remove it or use a valid aria-* attribute.",
          });
        }
      },
    }),
  },
  {
    meta: {
      id: "meta-viewport-zoom",
      title: "Do not disable zoom",
      wcag: ["1.4.4"],
      severity: "critical",
      description: "user-scalable=no or maximum-scale < 2 prevents low-vision users from zooming.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "meta" || sv(el, "name")?.toLowerCase() !== "viewport") return;
        const content = (sv(el, "content") ?? "").toLowerCase();
        const noScale = /user-scalable\s*=\s*(no|0)\b/.test(content);
        const max = /maximum-scale\s*=\s*([\d.]+)/.exec(content);
        if (!noScale && !(max && Number(max[1]) < 2)) return;
        ctx.report({
          el,
          message: "Viewport meta tag disables or limits pinch-zoom.",
          fix: 'Use <meta name="viewport" content="width=device-width, initial-scale=1"> (drop user-scalable and maximum-scale).',
        });
      },
    }),
  },
  {
    meta: {
      id: "video-captions",
      title: "Videos must have captions",
      wcag: ["1.2.2"],
      severity: "serious",
      description: "<video> with audio needs <track kind=\"captions\">.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "video" || has(el, "muted") || el.hasSpread) return;
        // No src and no <source>: almost always a live stream (getUserMedia) or set by script; 1.2.2 covers prerecorded media.
        if (!has(el, "src") && !el.children.some((c) => c.type === "element" && c.tag === "source")) return;
        const tracks = el.children.filter((c): c is ElementNode => c.type === "element" && c.tag === "track");
        if (el.children.some((c) => c.type === "element" && c.isComponent) || el.children.some((c) => c.type === "text" && c.dynamic)) return;
        if (tracks.some((t) => isDynamic(t, "kind") || ["captions", "subtitles"].includes(sv(t, "kind") ?? ""))) return;
        ctx.report({
          el,
          message: "Video has no captions track.",
          fix: 'Add <track kind="captions" src="captions.vtt" srclang="en" label="English">. If the video has no audio, add the muted attribute.',
          confidence: "medium",
        });
      },
    }),
  },
  {
    meta: {
      id: "no-distracting-elements",
      title: "Do not use <marquee> or <blink>",
      wcag: ["2.2.2"],
      severity: "serious",
      description: "Moving content that cannot be paused distracts and can be unreadable.",
    },
    create: (ctx) => ({
      element(el) {
        if (el.tag !== "marquee" && el.tag !== "blink") return;
        ctx.report({ el, message: `<${el.tag}> creates moving content that cannot be paused.`, fix: "Remove it; if motion is essential, provide a pause control and respect prefers-reduced-motion." });
      },
    }),
  },
  {
    meta: {
      id: "no-autofocus",
      title: "Avoid autofocus",
      wcag: ["2.4.3", "3.2.1"],
      severity: "minor",
      description: "autofocus moves focus unexpectedly and skips content for screen-reader users.",
    },
    create: (ctx) => ({
      element(el) {
        if (!has(el, "autofocus") || sv(el, "autofocus") === "false") return;
        // On a component, autoFocus is that component's API (it may focus a canvas, a dialog, or nothing).
        if (el.isComponent) return;
        // Dialogs and popups may (and should) set initial focus.
        const popup = (p: ElementNode) =>
          p.tag === "dialog" || ["dialog", "alertdialog", "menu", "listbox"].includes(roleOf(p) ?? "") || (p.isComponent && /Dialog|Modal|Drawer|Popover|Sheet|Menu|Dropdown|Command|Combobox|Popup|Overlay/.test(p.tag));
        if (ancestor(el, popup)) return;
        ctx.report({
          el,
          message: "autofocus moves focus on load, disorienting keyboard and screen-reader users.",
          fix: "Remove autofocus unless this is the sole purpose of the page (e.g. a search page) or the first control in a dialog.",
          confidence: "medium",
        });
      },
    }),
  },
];

export const ruleById = new Map(rules.map((r) => [r.meta.id, r]));
