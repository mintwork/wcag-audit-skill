/**
 * Angular components with an inline `template:` in `@Component({...})`. The template is parsed as
 * HTML (Angular template syntax is HTML: `(click)`, `[attr.aria-label]`, `*ngIf`, `@if {}`), on a copy
 * of the file where everything else is blanked, so line and column numbers match the .ts source.
 */
import { parse } from "@babel/parser";
import type { ParsedDocument } from "./ast.js";
import { parseMarkup } from "./parse-html.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** Cheap pre-check before parsing TypeScript. */
export function mayHaveInlineTemplate(source: string): boolean {
  return /@Component\s*\(/.test(source) && /\btemplate\s*:/.test(source);
}

/** [start, end) offsets of each inline template's text in the source. */
export function inlineTemplateRanges(source: string): Array<[number, number]> {
  let ast: AnyNode;
  try {
    ast = parse(source, { sourceType: "module", errorRecovery: true, plugins: ["typescript", "decorators-legacy"] });
  } catch {
    return [];
  }
  const ranges: Array<[number, number]> = [];
  const visit = (node: AnyNode) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n);
      return;
    }
    if (node.type === "Decorator" && node.expression?.type === "CallExpression" && node.expression.callee?.name === "Component") {
      const arg = node.expression.arguments?.[0];
      for (const prop of arg?.type === "ObjectExpression" ? arg.properties : []) {
        const key = prop.key?.name ?? prop.key?.value;
        if (key !== "template") continue;
        const v = prop.value;
        // Only literal templates: a template built with ${…} or concatenation is not statically known.
        if (v?.type === "StringLiteral" || (v?.type === "TemplateLiteral" && v.expressions.length === 0)) ranges.push([v.start + 1, v.end - 1]);
      }
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments" || key === "extra") continue;
      const child = node[key];
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(ast.program);
  return ranges;
}

export function parseAngularComponent(file: string, source: string): ParsedDocument | undefined {
  const ranges = inlineTemplateRanges(source);
  if (!ranges.length) return undefined;
  // Keep newlines everywhere so positions line up; keep the template text, blank the TypeScript.
  let masked = source.replace(/[^\n]/g, " ");
  for (const [s, e] of ranges) masked = masked.slice(0, s) + unescapeSameLength(source.slice(s, e)) + masked.slice(e);
  const doc = parseMarkup(file, masked, "html");
  return { ...doc, source };
}

/** `\`` and `\'` inside the literal are template text; replace the backslash with a space (same length). */
function unescapeSameLength(s: string): string {
  return s.replace(/\\([`'"\\$])/g, " $1");
}
