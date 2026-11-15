import { parse } from "@babel/parser";
import { type Attr, type ElementNode, type ModuleInfo, type Node, type ParsedDocument, createRoot, normalizeAttrName } from "./ast.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyNode = any;

/** Components that behave like intrinsic elements for a11y purposes. */
const COMPONENT_ALIASES: Record<string, string> = {
  Image: "img", // next/image, astro:assets
  Img: "img",
  Link: "a", // next/link, react-router, remix
  NavLink: "a",
};

/** Packages whose exports are icon components (render a graphic, never text). Subpaths included. */
const ICON_PACKAGE =
  /^(lucide-react|lucide-preact|lucide-solid|@mui\/icons-material|@material-ui\/icons|react-icons|@heroicons\/react|@radix-ui\/react-icons|@tabler\/icons-react|react-feather|@phosphor-icons\/react|phosphor-react|@fortawesome\/react-fontawesome|@iconify\/react|@ant-design\/icons|@primer\/octicons-react|react-bootstrap-icons|@carbon\/icons-react|@chakra-ui\/icons|@remixicon\/react|@hugeicons\/react|~icons|virtual:icons)(\/|$)/;

/** Parses .jsx/.tsx/.js files with Babel and extracts every JSX tree. */
export function parseJsx(file: string, source: string): ParsedDocument {
  const root = createRoot();
  const errors: string[] = [];
  const isTs = /\.(tsx|ts|mts|cts)$/.test(file);
  let ast: AnyNode;
  try {
    ast = parse(source, {
      sourceType: "module",
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: isTs ? ["jsx", "typescript", "decorators-legacy"] : ["jsx", "decorators-legacy"],
    });
  } catch (err) {
    errors.push((err as Error).message);
    return { file, framework: "jsx", source, root, parseErrors: errors };
  }
  for (const e of ast.errors ?? []) errors.push(String(e.message ?? e));

  const iconNames = new Set<string>();
  for (const stmt of ast.program.body ?? []) {
    if (stmt.type !== "ImportDeclaration" || !ICON_PACKAGE.test(String(stmt.source?.value ?? ""))) continue;
    for (const spec of stmt.specifiers ?? []) if (spec.local?.name) iconNames.add(spec.local.name);
  }

  const components = new Map<string, ElementNode[]>();
  let scope: string | undefined;

  const visit = (node: AnyNode, parent: ElementNode) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) visit(c, parent);
      return;
    }
    if (node.type === "JSXElement") {
      const el = convertElement(node, parent);
      parent.children.push(el);
      if (parent === root && scope && /^[A-Z]/.test(scope)) {
        const list = components.get(scope) ?? [];
        list.push(el);
        components.set(scope, list);
      }
      return;
    }
    if (node.type === "JSXFragment") {
      for (const c of convertChildren(node.children, parent)) {
        parent.children.push(c);
        if (c.type === "element" && parent === root && scope && /^[A-Z]/.test(scope)) {
          const list = components.get(scope) ?? [];
          list.push(c);
          components.set(scope, list);
        }
      }
      return;
    }
    // Track the enclosing named function / component so per-component checks don't bleed across components.
    const named =
      (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id?.name
        ? node.id.name
        : node.type === "VariableDeclarator" && node.id?.type === "Identifier" && node.init && typeof node.init === "object"
          ? node.id.name
          : undefined;
    const saved = scope;
    if (named) scope = named;
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "start" || key === "end" || key === "leadingComments" || key === "trailingComments" || key === "extra") continue;
      const v = node[key];
      if (v && typeof v === "object") visit(v, parent);
    }
    scope = saved;
  };

  const convertElement = (node: AnyNode, parent: ElementNode): ElementNode => {
    const opening = node.openingElement;
    const rawTag = jsxName(opening.name);
    const intrinsic = /^[a-z]/.test(rawTag) && !rawTag.includes(".") && !rawTag.includes("-");
    const alias = COMPONENT_ALIASES[rawTag];
    const attrs = new Map<string, Attr>();
    let hasSpread = false;
    const spreads: string[] = [];
    for (const a of opening.attributes) {
      if (a.type === "JSXSpreadAttribute") {
        hasSpread = true;
        spreads.push(source.slice(a.argument.start, a.argument.end));
        continue;
      }
      const rawName = jsxName(a.name);
      const norm = normalizeAttrName(rawName, "jsx");
      if (!norm) continue;
      const { value, dynamic } = attrValue(a.value);
      let name = norm.name;
      if (alias === "a" && name === "to") name = "href";
      const expr = dynamic && a.value?.type === "JSXExpressionContainer" ? source.slice(a.value.expression.start, a.value.expression.end) : undefined;
      attrs.set(name, { name, rawName, value, dynamic, expr });
    }
    const el: ElementNode = {
      type: "element",
      tag: intrinsic ? rawTag.toLowerCase() : alias ?? rawTag,
      isComponent: !intrinsic && !alias,
      isIcon: !intrinsic && iconNames.has(rawTag.split(".")[0]!),
      scope,
      attrs,
      hasSpread,
      spreads: spreads.length ? spreads : undefined,
      children: [],
      parent,
      line: opening.loc.start.line,
      column: opening.loc.start.column + 1,
      openTag: source.slice(opening.start, opening.end),
    };
    el.children = convertChildren(node.children, el);
    // dangerouslySetInnerHTML fills the element with content we cannot see.
    if (attrs.has("dangerouslysetinnerhtml")) el.children.push({ type: "text", text: "", dynamic: true });
    return el;
  };

  const convertChildren = (children: AnyNode[], parent: ElementNode): Node[] => {
    const out: Node[] = [];
    for (const c of children) {
      switch (c.type) {
        case "JSXText":
          if (c.value.trim()) out.push({ type: "text", text: c.value, dynamic: false });
          break;
        case "JSXElement":
          out.push(convertElement(c, parent));
          break;
        case "JSXFragment":
          out.push(...convertChildren(c.children, parent));
          break;
        case "JSXExpressionContainer": {
          const e = c.expression;
          if (e.type === "JSXEmptyExpression") break;
          if (e.type === "StringLiteral" || (e.type === "TemplateLiteral" && e.expressions.length === 0)) {
            const text = e.type === "StringLiteral" ? e.value : e.quasis[0].value.cooked;
            if (text.trim()) out.push({ type: "text", text, dynamic: false });
            break;
          }
          if (e.type === "JSXElement") {
            out.push(convertElement(e, parent));
            break;
          }
          // Arbitrary expression: may render text. Collect nested JSX as children.
          out.push({ type: "text", text: "", dynamic: true, expr: source.slice(e.start, e.end) });
          const holder = { ...parent, children: [] as Node[] };
          visit(e, holder);
          const conditional = e.type === "LogicalExpression" || e.type === "ConditionalExpression";
          for (const child of holder.children) {
            if (child.type === "element") {
              child.parent = parent;
              if (conditional) child.conditional = true;
            }
            out.push(child);
          }
          break;
        }
        case "JSXSpreadChild":
          out.push({ type: "text", text: "", dynamic: true });
          break;
      }
    }
    return out;
  };

  visit(ast.program, root);
  return { file, framework: "jsx", source, root, parseErrors: errors, components, modules: moduleInfo(ast.program.body ?? []) };
}

function moduleInfo(body: AnyNode[]): ModuleInfo {
  const info: ModuleInfo = { imports: new Map(), exports: new Map(), reexports: [], exportAll: [] };
  const name = (n: AnyNode): string => (n?.type === "StringLiteral" ? n.value : n?.name);
  for (const stmt of body) {
    const source = stmt.source?.value as string | undefined;
    if (stmt.type === "ImportDeclaration" && source) {
      for (const spec of stmt.specifiers ?? []) {
        const imported = spec.type === "ImportDefaultSpecifier" ? "default" : spec.type === "ImportNamespaceSpecifier" ? "*" : name(spec.imported);
        info.imports.set(spec.local.name, { source, imported });
      }
    } else if (stmt.type === "ExportNamedDeclaration") {
      const d = stmt.declaration;
      if (d?.id?.name) info.exports.set(d.id.name, d.id.name);
      for (const decl of d?.declarations ?? []) if (decl.id?.type === "Identifier") info.exports.set(decl.id.name, decl.id.name);
      for (const spec of stmt.specifiers ?? []) {
        const exported = name(spec.exported);
        if (source) info.reexports.push({ exported, imported: spec.type === "ExportNamespaceSpecifier" ? "*" : name(spec.local), source });
        else info.exports.set(exported, name(spec.local));
      }
    } else if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration;
      const local = d?.id?.name ?? (d?.type === "Identifier" ? d.name : undefined);
      if (local) info.exports.set("default", local);
    } else if (stmt.type === "ExportAllDeclaration" && source && !stmt.exported) {
      info.exportAll.push(source);
    }
  }
  return info;
}

function jsxName(n: AnyNode): string {
  switch (n.type) {
    case "JSXIdentifier":
      return n.name;
    case "JSXNamespacedName":
      return `${n.namespace.name}:${n.name.name}`;
    case "JSXMemberExpression":
      return `${jsxName(n.object)}.${n.property.name}`;
    default:
      return "";
  }
}

function attrValue(v: AnyNode): { value: string | null; dynamic: boolean } {
  if (v == null) return { value: "true", dynamic: false }; // <input disabled /> === disabled={true}
  if (v.type === "StringLiteral") return { value: v.value, dynamic: false };
  if (v.type === "JSXExpressionContainer") {
    const e = v.expression;
    switch (e.type) {
      case "StringLiteral":
        return { value: e.value, dynamic: false };
      case "NumericLiteral":
        return { value: String(e.value), dynamic: false };
      case "BooleanLiteral":
        return { value: String(e.value), dynamic: false };
      case "UnaryExpression":
        if (e.operator === "-" && e.argument.type === "NumericLiteral") return { value: String(-e.argument.value), dynamic: false };
        break;
      case "TemplateLiteral":
        if (e.expressions.length === 0) return { value: e.quasis[0].value.cooked, dynamic: false };
        break;
    }
  }
  return { value: null, dynamic: true };
}
