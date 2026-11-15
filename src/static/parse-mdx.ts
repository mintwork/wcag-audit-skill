/**
 * MDX: Markdown with JSX. The source is rewritten, line for line (no line is added or removed), into
 * markup the tolerant parser understands: frontmatter, ESM imports/exports, code blocks and inline code
 * are blanked (inline code becomes plain letters), and Markdown headings, links and images become <hN>, <a> and <img>. JSX elements and
 * {expressions} are kept as they are and parsed like Astro / JSX.
 */
import type { ParsedDocument } from "./ast.js";
import { parseMarkup } from "./parse-html.js";

const blank = (s: string) => s.replace(/[^\n]/g, " ");

export function prepareMdx(source: string): string {
  const lines = source.split("\n");
  let i = 0;
  // YAML / TOML frontmatter.
  if (/^(---|\+\+\+)\s*$/.test(lines[0] ?? "")) {
    const fence = lines[0]!.trim();
    for (let j = 1; j < lines.length; j++) {
      if (lines[j]!.trim() === fence) {
        for (let k = 0; k <= j; k++) lines[k] = blank(lines[k]!);
        i = j + 1;
        break;
      }
    }
  }
  /** Open code fence: its character and length; it closes with at least as many of the same. */
  let fence: { ch: string; len: number } | undefined;
  let esm = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1]![0] === fence.ch && close[1]!.length >= fence.len) fence = undefined;
      lines[i] = blank(line);
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { ch: open[1]![0]!, len: open[1]!.length };
      lines[i] = blank(line);
      continue;
    }
    // ESM blocks run until the next blank line (MDX requires the blank line).
    if (esm || /^(import|export)\s/.test(line)) {
      esm = line.trim() !== "";
      lines[i] = blank(line);
      continue;
    }
    lines[i] = rewriteInline(line);
  }
  return lines.join("\n");
}

function rewriteInline(line: string): string {
  // Inline code, then autolinks: content is text, never markup.
  // Inline code renders as text: keep it as plain letters so `[`code`](url)` still has link text.
  let out = maskInlineCode(line);
  out = out.replace(/<((https?|mailto|ftp):[^>\s]*)>/gi, (m) => blank(m));
  // ATX heading.
  const h = /^(\s{0,3})(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(out);
  if (h) out = `${h[1]}<h${h[2]!.length}>${h[3]}</h${h[2]!.length}>`;
  // Images ![alt](src "title") and links [text](href "title"). Reference links are left alone.
  out = out.replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g, (_m, alt: string, src: string) => `<img src="${attrText(src)}" alt="${attrText(alt)}">`);
  out = out.replace(/(^|[^\\!])\[([^\]]*)\]\(\s*<?([^)\s>]*)>?(?:\s+["'][^"']*["'])?\s*\)/g, (_m, pre: string, text: string, href: string) => `${pre}<a href="${attrText(href)}">${text}</a>`);
  return out;
}

/** Replaces inline code spans (`a`, ``a ` b``) with letters, in linear time. */
function maskInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      const next = line.indexOf("`", i);
      const stop = next === -1 ? line.length : next;
      out += line.slice(i, stop);
      i = stop;
      continue;
    }
    let run = i;
    while (line[run] === "`") run++;
    const fence = line.slice(i, run);
    // The span closes at the next run of exactly the same length.
    let close = line.indexOf(fence, run);
    while (close !== -1 && (line[close + fence.length] === "`" || line[close - 1] === "`")) {
      let skip = close;
      while (line[skip] === "`") skip++;
      close = line.indexOf(fence, skip);
    }
    if (close === -1) {
      out += fence;
      i = run;
      continue;
    }
    out += line.slice(i, close + fence.length).replace(/\S/g, "x");
    i = close + fence.length;
  }
  return out;
}

function attrText(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/[*_]/g, "");
}

export function parseMdx(file: string, source: string): ParsedDocument {
  const doc = parseMarkup(file, prepareMdx(source), "mdx");
  return { ...doc, source };
}
