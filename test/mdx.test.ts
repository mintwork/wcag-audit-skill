import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource, scanStatic } from "../src/static/analyze.js";
import { prepareMdx } from "../src/static/parse-mdx.js";

const run = (src: string) => analyzeSource("doc.mdx", src).map((f) => `${f.ruleId}:${f.location.line}`);

describe("MDX", () => {
  it("keeps line numbers while blanking frontmatter, ESM, code and autolinks", () => {
    const src = `---\ntitle: x\n---\nimport A from "a";\n\n# T\n\n\`\`\`html\n<img src="x">\n\`\`\`\n\n<https://x.dev> \`<img>\``;
    const out = prepareMdx(src);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).not.toMatch(/title|import|<img|https/);
    expect(out.split("\n")[5]).toBe("<h1>T</h1>");
  });

  it("scans JSX and HTML in MDX with JSX attribute names", () => {
    const src = `# Doc\n\n<img src="/a.png" />\n<button className="x"><svg /></button>\n<label htmlFor="e">Email</label><input id="e" />\n<Callout>Text</Callout>`;
    expect(run(src)).toEqual(["img-alt:3", "button-name:4"]);
  });

  it("turns Markdown headings, links and images into elements", () => {
    const src = `# Title\n\n### Skipped\n\nSee [click here](/docs) or [](/empty).\n\n![image](/a.png)\n![](/decorative.png)`;
    expect(run(src)).toEqual(["heading-order:3", "link-name:5", "link-text-vague:5", "img-alt-meaningful:7"]);
  });

  it("treats inline code in link text as text, and skips fenced code (``` and ~~~, longer fences)", () => {
    expect(run("Use [`@source inline()`](/docs/source).")).toEqual([]);
    expect(run("~~~~\n<img src=x>\n~~~\nstill code <img src=y>\n~~~~\n\nafter")).toEqual([]);
  });

  it("parses JSX inside {expressions}", () => {
    expect(run(`{items.map((i) => <a href={i.url}></a>)}`)).toEqual(["link-name:1"]);
  });

  it("the clean MDX fixture has no findings, and .mdx files are collected", async () => {
    const r = await scanStatic(path.join(__dirname, "fixtures/static/good"));
    expect(r.findings).toEqual([]);
    expect(r.filesScanned).toBeGreaterThanOrEqual(5);
  });
});
