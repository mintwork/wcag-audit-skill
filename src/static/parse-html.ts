import {
  type Attr,
  type ElementNode,
  type Framework,
  type ParsedDocument,
  VOID_ELEMENTS,
  createRoot,
  lineStarts,
  normalizeAttrName,
  positionAt,
} from "./ast.js";

const RAW_TEXT = new Set(["script", "style"]);
/** Escapable raw text: content is text, never markup (a "<html>" typed inside a <textarea> is not an element). */
const RCDATA = new Set(["textarea", "title"]);
/** Directives that replace an element's content with something we cannot see statically. */
const CONTENT_DIRECTIVES = new Set(["set:html", "set:text", "v-html", "v-text", "[innerhtml]", "[textcontent]", "[innertext]", "innerhtml", "textcontent"]);
/** Server-side template placeholders inside attribute values: lang="%lang%", lang="<%= locale %>", {% … %}. */
const TEMPLATE_VALUE = /%[\w.-]+%|<%|\{\{|\{%|\$\{/;

/**
 * Tolerant, dependency-free markup parser for HTML, Vue SFCs, Svelte and Astro.
 * It never throws: malformed markup is recovered from best-effort, which is the
 * right trade-off for a linter (we would rather scan 99% of a file than none).
 */
export function parseMarkup(file: string, source: string, framework: Framework): ParsedDocument {
  const root = createRoot();
  const starts = lineStarts(source);
  const errors: string[] = [];
  const stack: ElementNode[] = [root];
  const textHasExpr = framework === "html" ? /\{\{/ : framework === "vue" ? /\{\{/ : /[{}]/;

  let i = 0;
  let ifDepth = 0;
  /** Astro: end offsets of the {expressions} we are currently inside; markup there renders conditionally or in a loop. */
  const astroExprEnds: number[] = [];
  // Astro frontmatter (--- ... ---) is TypeScript, not markup.
  if (framework === "astro" && source.startsWith("---")) {
    const end = source.indexOf("\n---", 3);
    if (end !== -1) i = end + 4;
  }

  const n = source.length;
  let textStart = i;

  const flushText = (end: number) => {
    if (end > textStart) {
      const text = source.slice(textStart, end);
      if (text.trim()) {
        const top = stack[stack.length - 1]!;
        top.children.push({ type: "text", text: decodeEntities(text), dynamic: textHasExpr.test(text) });
      }
    }
  };

  while (i < n) {
    const ch = source[i];
    // Svelte / Astro expressions in text: skip balanced braces so `<` inside is not a tag.
    if (ch === "{" && (framework === "svelte" || framework === "astro" || framework === "mdx")) {
      const end = skipBraces(source, i);
      // Astro expressions are JSX: {items.map((i) => <li>…</li>)}, {open && <Modal />}. Parse the markup inside.
      if ((framework === "astro" || framework === "mdx") && /<[A-Za-z]/.test(source.slice(i, end))) {
        astroExprEnds.push(end);
        i++;
        continue;
      }
      if (framework === "svelte") {
        const block = /^\{\s*([#/:])\s*(\w+)/.exec(source.slice(i, i + 20));
        if (block?.[2] === "if") ifDepth += block[1] === "#" ? 1 : block[1] === "/" ? -1 : 0;
      }
      i = end;
      continue;
    }
    if (ch !== "<") {
      i++;
      continue;
    }
    if (source.startsWith("<!--", i)) {
      flushText(i);
      const end = source.indexOf("-->", i + 4);
      i = end === -1 ? n : end + 3;
      textStart = i;
      continue;
    }
    if (source[i + 1] === "!" || source[i + 1] === "?") {
      flushText(i);
      const end = source.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      textStart = i;
      continue;
    }
    if (source[i + 1] === "/") {
      const m = /^<\/([A-Za-z][\w:.-]*)\s*>/.exec(source.slice(i, i + 200));
      if (!m) {
        i++;
        continue;
      }
      flushText(i);
      const closeName = normalizeTag(m[1]!);
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s]!.tag === closeName) {
          stack.length = s;
          break;
        }
      }
      i += m[0].length;
      textStart = i;
      continue;
    }
    if (!/[A-Za-z]/.test(source[i + 1] ?? "")) {
      i++;
      continue;
    }

    // Opening tag
    flushText(i);
    const tagStart = i;
    i++;
    const nameMatch = /^[A-Za-z][\w:.-]*/.exec(source.slice(i, i + 100))!;
    const rawTag = nameMatch[0];
    i += rawTag.length;
    const attrs = new Map<string, Attr>();
    let hasSpread = false;
    let selfClosing = false;
    let fillsContent = false;
    let conditional = false;

    while (i < n) {
      while (i < n && /\s/.test(source[i]!)) i++;
      if (i >= n) break;
      if (source[i] === ">") {
        i++;
        break;
      }
      if (source[i] === "/" && source[i + 1] === ">") {
        selfClosing = true;
        i += 2;
        break;
      }
      if (source[i] === "/") {
        i++;
        continue;
      }
      if (source[i] === "{") {
        // Svelte {...props} or {alt} shorthand
        const end = skipBraces(source, i);
        const inner = source.slice(i + 1, end - 1).trim();
        if (inner.startsWith("...")) hasSpread = true;
        else if (/^[A-Za-z_$][\w$-]*$/.test(inner)) {
          const norm = normalizeAttrName(inner, framework);
          if (norm) attrs.set(norm.name, { name: norm.name, rawName: inner, value: null, dynamic: true });
        }
        i = end;
        continue;
      }
      const am = /^[^\s=>/"']+/.exec(source.slice(i, i + 300));
      if (!am) {
        i++;
        continue;
      }
      const rawName = am[0];
      i += rawName.length;
      let value: string | null = "";
      let dynamic = false;
      let j = i;
      while (j < n && /\s/.test(source[j]!)) j++;
      if (source[j] === "=") {
        j++;
        while (j < n && /\s/.test(source[j]!)) j++;
        const q = source[j];
        if (q === '"' || q === "'") {
          const end = source.indexOf(q, j + 1);
          const stop = end === -1 ? n : end;
          value = source.slice(j + 1, stop);
          i = stop + 1;
        } else if (q === "{") {
          const end = skipBraces(source, j);
          value = null;
          dynamic = true;
          i = end;
        } else {
          const um = /^[^\s>]*/.exec(source.slice(j))!;
          value = um[0];
          i = j + um[0].length;
        }
      }
      if (rawName === "v-bind" || rawName === "v-on") {
        hasSpread = true;
        continue;
      }
      if (CONTENT_DIRECTIVES.has(rawName.toLowerCase())) fillsContent = true;
      if (/^v-(if|else-if|else|show)$/.test(rawName) || rawName === "*ngIf" || rawName === "x-if" || rawName === "x-show") conditional = true;
      const norm = normalizeAttrName(rawName, framework);
      if (!norm) continue;
      const expr = value === null ? source.slice(j + 1, i - 1) : value;
      if (norm.forceDynamic) dynamic = true;
      if (value !== null && (TEMPLATE_VALUE.test(value) || ((framework === "svelte" || framework === "astro" || framework === "mdx") && /[{}]/.test(value)))) {
        dynamic = true;
      }
      attrs.set(norm.name, {
        name: norm.name,
        rawName,
        value: dynamic ? null : decodeEntities(value ?? ""),
        dynamic,
        expr: dynamic ? expr : undefined,
      });
    }

    const tag = normalizeTag(rawTag);
    const pos = positionAt(starts, tagStart);
    const parent = stack[stack.length - 1]!;
    const el: ElementNode = {
      type: "element",
      tag,
      isComponent: isComponentTag(rawTag, framework),
      attrs,
      hasSpread,
      children: [],
      parent,
      line: pos.line,
      column: pos.column,
      openTag: source.slice(tagStart, i),
      conditional: conditional || insideAstroExpr(astroExprEnds, tagStart) || undefined,
      ifDepth: ifDepth || undefined,
    };
    parent.children.push(el);
    if (fillsContent) el.children.push({ type: "text", text: "", dynamic: true });

    // In plain HTML, "/>" on a non-void element is ignored (<button/>Save</button> contains "Save"),
    // except in foreign content (<svg>, <math>) where it really self-closes.
    if (selfClosing && framework === "html" && !VOID_ELEMENTS.has(tag) && !inForeignContent(el)) selfClosing = false;

    if ((RAW_TEXT.has(tag) || RCDATA.has(tag)) && !selfClosing) {
      const close = source.toLowerCase().indexOf(`</${tag}`, i);
      const end = close === -1 ? n : close;
      if (RCDATA.has(tag)) {
        const text = source.slice(i, end);
        if (text.trim()) el.children.push({ type: "text", text: decodeEntities(text), dynamic: textHasExpr.test(text) });
      }
      i = end;
      textStart = i;
      continue;
    }
    if (!selfClosing && !VOID_ELEMENTS.has(tag)) stack.push(el);
    textStart = i;
  }
  flushText(n);
  if (stack.length > 1 && framework === "html") {
    // Unclosed elements are legal in HTML (implicit end tags); nothing to report.
  }
  return { file, framework, source, root, parseErrors: errors };
}

function insideAstroExpr(ends: number[], at: number): boolean {
  while (ends.length && ends[ends.length - 1]! <= at) ends.pop();
  return ends.length > 0;
}

function inForeignContent(el: ElementNode): boolean {
  for (let e: ElementNode | null = el; e; e = e.parent) if (e.tag === "svg" || e.tag === "math") return true;
  return false;
}

function normalizeTag(raw: string): string {
  // Keep component casing (MyButton), lowercase plain HTML tags.
  return /^[a-z]/.test(raw) && !raw.includes(".") ? raw.toLowerCase() : raw;
}

function isComponentTag(raw: string, framework: Framework): boolean {
  if (/^[A-Z]/.test(raw) || raw.includes(".")) return true;
  // Custom elements (my-widget) and Vue kebab components (router-link) are opaque to us.
  if (raw.includes("-")) return true;
  if (framework === "svelte" && raw.includes(":")) return true; // svelte:head etc.
  return false;
}

/** Returns index just past the matching closing brace, honoring strings. */
export function skipBraces(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'" || c === "`") {
      const end = findStringEnd(source, i);
      i = end;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return source.length;
}

function findStringEnd(source: string, start: number): number {
  const q = source[start];
  let i = start + 1;
  while (i < source.length) {
    const c = source[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === q) return i + 1;
    if (c === "\n" && q !== "`") return i + 1;
    i++;
  }
  return source.length;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
