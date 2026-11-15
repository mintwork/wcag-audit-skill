/**
 * Regressions found by field-testing the scanner on real projects. Each case is a minimal synthetic
 * snippet of a pattern that produced a false positive (or a miss) in the wild.
 */
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/static/analyze.js";

const rulesIn = (file: string, src: string) => analyzeSource(file, src).map((f) => f.ruleId);
const lines = (file: string, src: string, rule: string) => analyzeSource(file, src).filter((f) => f.ruleId === rule).map((f) => f.location.line);

describe("HTML parsing", () => {
  it("ignores '/>' on non-void HTML elements (<button/>Text</button> has text)", () => {
    expect(rulesIn("a.html", `<p><button id="a"/>Normal</button></p>`)).not.toContain("button-name");
    // ...but still honors it in SVG, where it really self-closes.
    expect(rulesIn("b.html", `<button><svg><path d="M0"/></svg></button>`)).toContain("button-name");
  });

  it("ends HTML comments where a browser does, so markup after them is still scanned", () => {
    for (const comment of ["<!-- note --!>", "<!-->", "<!--->", "<!-- a -- b -->", "<!---->"]) {
      expect(rulesIn("a.html", `<p>${comment}<img src="x.png"></p>`), comment).toContain("img-alt");
    }
    // Markup inside a comment is not scanned, and an unterminated comment runs to the end of the file.
    expect(rulesIn("b.html", `<p><!-- <img src="x.png"> --></p>`)).not.toContain("img-alt");
    expect(rulesIn("c.html", `<p><!-- <img src="x.png"> --></p><!-- <img src="y.png">`)).not.toContain("img-alt");
  });

  it("treats <textarea> and <title> content as text, not markup", () => {
    const src = `<!doctype html><html lang="en"><head><title>Demo</title></head><body>
<label>Code <textarea><html><head><title></title></head></html></textarea></label></body></html>`;
    expect(rulesIn("a.html", src)).toEqual([]);
  });

  it("does not require <title> when the head is injected by a template", () => {
    for (const head of ["%sveltekit.head%", "<!--app-head-->", "<%= htmlWebpackPlugin.tags.headTags %>"]) {
      expect(rulesIn("app.html", `<!doctype html><html lang="en"><head>${head}</head><body></body></html>`)).toEqual([]);
    }
  });

  it("treats template placeholders in attribute values as dynamic", () => {
    expect(rulesIn("a.html", `<html lang="%lang%"><head><title>x</title></head></html>`)).toEqual([]);
  });

  it("content directives fill the element (Astro set:html, Vue v-html)", () => {
    expect(rulesIn("Hero.astro", `<h1 set:html={title} />`)).toEqual([]);
    expect(rulesIn("Hero.vue", `<template><h2 v-html="title"></h2><button v-text="label"></button></template>`)).toEqual([]);
    expect(rulesIn("Hero.tsx", `export const H = () => <h2 dangerouslySetInnerHTML={{ __html: t }} />;`)).toEqual([]);
  });
});

describe("no-div-button", () => {
  it("skips handlers that only stop propagation", () => {
    expect(rulesIn("D.vue", `<template><div class="dialog" @click.stop><p>Hi</p></div></template>`)).toEqual([]);
    expect(rulesIn("D.svelte", `<span onclick={(e) => e.stopPropagation()}>{text}</span>`)).toEqual([]);
    expect(rulesIn("D.tsx", `export const D = () => <div onClick={(e) => { e.stopPropagation(); }}>x</div>;`)).toEqual([]);
    // A real handler is still reported.
    expect(rulesIn("E.tsx", `export const D = () => <div onClick={(e) => { e.stopPropagation(); go(); }}>x</div>;`)).toContain("no-div-button");
    // Parameter names with regex metacharacters (`$`) are matched literally, and must be the object called on.
    expect(rulesIn("F.tsx", `export const D = () => <div onClick={($) => $.stopPropagation()}>x</div>;`)).toEqual([]);
    expect(rulesIn("G.tsx", `export const D = () => <div onClick={($e) => $e.stopPropagation()}>x</div>;`)).toEqual([]);
    expect(rulesIn("H.tsx", `export const D = () => <div onClick={($) => x.stopPropagation()}>x</div>;`)).toContain("no-div-button");
    expect(rulesIn("I.tsx", `export const D = () => <div onClick={(e) => eX.stopPropagation()}>x</div>;`)).toContain("no-div-button");
  });

  it("skips containers whose click comes from an always-rendered native control inside", () => {
    expect(rulesIn("M.tsx", `export const M = () => <li onClick={run}><button type="button">Run</button></li>;`)).toEqual([]);
    // Conditionally rendered controls do not count: the click is what reveals them.
    expect(rulesIn("C.vue", `<template><div @click="edit = true">{{ v }}<input v-if="edit" aria-label="v"></div></template>`)).toContain("no-div-button");
    expect(rulesIn("C.tsx", `export const C = () => <div onClick={edit}>{v}{editing && <input aria-label="v" />}</div>;`)).toContain("no-div-button");
    // Drag gestures are not equivalent to the link inside.
    expect(rulesIn("G.vue", `<template><div @mousedown="drag"><a href="/src">Source</a></div></template>`)).toContain("no-div-button");
  });

  it("skips children of react-aria <Pressable>, which injects tabIndex and key handlers", () => {
    const src = `export const P = () => <Pressable><div role="button">Right click here</div></Pressable>;`;
    expect(rulesIn("P.tsx", src)).toEqual([]);
  });
});

describe("button-name", () => {
  it("a wrapping <label> with text names the button", () => {
    expect(rulesIn("B.svelte", `<label><button onclick={back}><Icon name="arrow-left" /></button><span>Back</span></label>`)).toEqual([]);
    expect(rulesIn("B.html", `<label for="go">Go</label><button id="go"><img src="go.svg" alt=""></button>`)).toEqual([]);
  });

  it("knows icons imported from icon libraries, even without 'Icon' in the name", () => {
    const src = `import { Close } from "@mui/icons-material";\nexport const B = () => <button onClick={close}><Close /></button>;`;
    expect(rulesIn("B.tsx", src)).toContain("button-name");
  });

  it("reports icon-only <IconButton>/<Button> components (medium confidence)", () => {
    const src = `import Close from "@mui/icons-material/Close";
export const A = () => <IconButton onClick={close}><Close /></IconButton>;
export const B = () => <Button size="icon"><PlusIcon /></Button>;
export const C = () => <IconButton aria-label="Close"><Close /></IconButton>;
export const D = () => <Button size="icon"><PlusIcon /><span className="sr-only">Add</span></Button>;
export const E = () => <Button>{t("save")}</Button>;
export const F = () => <IconButton label="Close" icon={<Close />} />;`;
    const f = analyzeSource("A.tsx", src).filter((x) => x.ruleId === "button-name");
    expect(f.map((x) => x.location.line)).toEqual([2, 3]);
    expect(f.every((x) => x.confidence === "medium")).toBe(true);
  });
});

describe("form-label", () => {
  it("reports controls inside a same-file <Field> wrapper whose <label> is not associated", () => {
    const src = `function Field({ label, children }) {
  return <div>{label && <label className="l">{label}</label>}{children}</div>;
}
export function Form() {
  return <Field label="Region"><input value={v} onChange={set} /></Field>;
}`;
    const f = analyzeSource("F.jsx", src).filter((x) => x.ruleId === "form-label");
    expect(f.map((x) => [x.location.line, x.confidence])).toEqual([[5, "medium"]]);
  });

  it("trusts a wrapper that wraps children in the label, uses htmlFor, or is not defined in this file", () => {
    const wraps = `function Field({ label, children }) { return <label>{label}{children}</label>; }
export const A = () => <Field label="x"><input /></Field>;`;
    const forAttr = `function Field({ id, label, children }) { return <div><label htmlFor={id}>{label}</label>{children}</div>; }
export const A = () => <Field id="x" label="x"><input id="x" /></Field>;`;
    const imported = `import { Field } from "./ui";\nexport const A = () => <Field label="x"><input /></Field>;`;
    for (const src of [wraps, forAttr, imported]) expect(rulesIn("F.jsx", src)).not.toContain("form-label");
  });

  it("checks inputs whose bound type can only be text-like (show ? 'text' : 'password')", () => {
    expect(rulesIn("P.tsx", `export const P = () => <input type={show ? "text" : "password"} value={v} />;`)).toContain("form-label");
    expect(rulesIn("Q.tsx", `export const P = () => <input type={kind} value={v} />;`)).toEqual([]);
    expect(rulesIn("R.tsx", `export const P = () => <input type={x ? "hidden" : "text"} />;`)).toEqual([]);
  });

  it("does not call a label that wraps a different control an orphan", () => {
    const [f] = analyzeSource("x.html", `<select size="5"></select>\n<label>Name: <input></label>`).filter((x) => x.ruleId === "form-label");
    expect(f!.message).not.toMatch(/sits next to/);
  });
});

describe("heading-order", () => {
  it("does not compare headings across separately rendered JSX trees (components)", () => {
    const src = `export function Page() { return <h1>Title</h1>; }
export function Card() { return <div><h3>Card</h3></div>; }`;
    expect(rulesIn("P.tsx", src)).toEqual([]);
    expect(lines("Q.tsx", `export const P = () => <main><h1>T</h1><h3>S</h3></main>;`, "heading-order")).toEqual([1]);
  });
});

describe("no-autofocus", () => {
  it("ignores autoFocus props on components and focus inside popups/menus", () => {
    expect(rulesIn("A.tsx", `export const A = () => <Excalidraw autoFocus />;`)).toEqual([]);
    expect(rulesIn("B.tsx", `export const B = () => <DropdownMenuSubContent><input aria-label="Filter" autoFocus /></DropdownMenuSubContent>;`)).toEqual([]);
    expect(rulesIn("C.tsx", `export const C = () => <input aria-label="Name" autoFocus />;`)).toContain("no-autofocus");
  });
});

describe("link-text-vague", () => {
  it('does not treat the language "Go" as vague link text', () => {
    expect(rulesIn("a.html", `<ul><li><a href="mode/go/">Go</a></li></ul>`)).toEqual([]);
  });
});

describe("file collection and locations", () => {
  it("skips test fixtures and Python virtualenvs by default", async () => {
    const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { scanStatic } = await import("../src/static/analyze.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-ignore-"));
    for (const d of ["src", "fixtures", "test", "venv/lib/site-packages"]) {
      await mkdir(path.join(dir, d), { recursive: true });
      await writeFile(path.join(dir, d, "x.html"), "<img src=a.png>");
    }
    const r = await scanStatic(dir, { cwd: dir });
    expect(r.findings.map((f) => f.location.file)).toEqual(["src/x.html"]);
  });

  it("uses absolute paths (and file:// SARIF URIs) for files outside cwd", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const { scanStatic } = await import("../src/static/analyze.js");
    const { formatSarif } = await import("../src/report/index.js");
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-abs-"));
    await writeFile(path.join(dir, "x.html"), "<img src=a.png>");
    const r = await scanStatic(dir, { cwd: path.join(os.tmpdir(), "elsewhere") }); // dir is a sibling, so "../…"
    const file = r.findings[0]!.location.file!;
    expect(path.isAbsolute(file)).toBe(true);
    expect(file).not.toContain("..");
    const loc = JSON.parse(formatSarif([r])).runs[0].results[0].locations[0].physicalLocation.artifactLocation;
    expect(loc.uri).toMatch(/^file:\/\//);
    expect(loc.uriBaseId).toBeUndefined();
  });
});

describe("interactive-role-keyboard", () => {
  it("counts capture-phase key handlers (onKeyDownCapture / onkeydowncapture)", () => {
    expect(rulesIn("S.tsx", `export const S = () => <div role="slider" tabIndex={0} aria-valuenow={1} onMouseDown={seek} onKeyDownCapture={keys} />;`)).toEqual([]);
    expect(rulesIn("S.svelte", `<div role="button" tabindex="0" onclick={go} onkeydowncapture={keys}>Go</div>`)).toEqual([]);
    expect(rulesIn("T.tsx", `export const S = () => <div role="button" tabIndex={0} onClick={go}>Go</div>;`)).toContain("interactive-role-keyboard");
  });

  it("does not treat a capture-phase click interceptor as a fake button", () => {
    expect(rulesIn("W.tsx", `export const W = () => <div ref={r} onClickCapture={intercept}><a href="/x">x</a></div>;`)).toEqual([]);
    expect(rulesIn("W.svelte", `<div {onclickcapture} bind:this={el}>{@html html}</div>`)).toEqual([]);
  });
});

describe("Astro expressions", () => {
  it("parses markup inside {expressions} (they are JSX)", () => {
    const src = `---\nconst xs = [1];\n---\n<ul>{xs.map((x) => <li><img src={x} /></li>)}</ul>\n{open && <a href="/x">Open</a>}`;
    expect(lines("L.astro", src, "img-alt")).toEqual([4]);
    expect(rulesIn("L.astro", src)).not.toContain("link-name");
  });
});
