import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource, scanStatic } from "../src/static/analyze.js";
import { isFocusReplacementToken, isOutlineNoneToken, parseCss } from "../src/static/css.js";

const RULE = "focus-outline-removed";
const find = (file: string, src: string) => analyzeSource(file, src).filter((f) => f.ruleId === RULE);
const lines = (file: string, src: string) => find(file, src).map((f) => f.location.line);

describe("CSS parsing", () => {
  it("resolves SCSS / Less nesting and & and skips comments, mixins and keyframes", () => {
    const rules = parseCss(`// outline: none\n.a { b { &:focus { outline: 0 } } &-x:hover { c: d } }\n@mixin m { outline: none }\n.m() { outline: none }\n@keyframes k { from { outline: 0 } }\n@media (x) { .z { outline: 0 } }`, "scss");
    expect(rules.map((r) => r.selectors.join(","))).toEqual([".a", ".a b", ".a b:focus", ".a-x:hover", ".z"]);
    expect(rules.find((r) => r.selectors[0] === ".a b:focus")!.decls).toEqual([{ prop: "outline", value: "0", offset: expect.any(Number) }]);
  });

  it("knows Tailwind outline-removal and focus-replacement utilities", () => {
    for (const t of ["outline-none", "focus:outline-none", "focus-visible:outline-0", "md:outline-hidden", "!outline-none"]) expect(isOutlineNoneToken(t), t).toBe(true);
    for (const t of ["hover:outline-none", "data-[state=open]:outline-none", "outline-transparent", "outline-2"]) expect(isOutlineNoneToken(t), t).toBe(false);
    for (const t of ["focus:ring-2", "focus-visible:outline-2", "focus-within:shadow-md", "data-[focus-visible]:ring", "data-highlighted:bg-accent", "focus-ring"]) expect(isFocusReplacementToken(t), t).toBe(true);
    for (const t of ["ring-2", "hover:ring-2", "focus:outline-none"]) expect(isFocusReplacementToken(t), t).toBe(false);
  });
});

describe("focus-outline-removed (2.4.7) in stylesheets", () => {
  it("reports outline removal on focus or focusable selectors without a replacement", () => {
    const src = `.btn:focus { outline: none; }\nbutton { outline: 0 }\n.card { outline: none }\n*:focus { outline: 0 !important }\na:focus { outline: 2px dotted transparent }`;
    const f = find("a.css", src);
    expect(f.map((x) => [x.location.line, x.confidence])).toEqual([
      [1, "high"],
      [2, "medium"],
      [4, "high"],
      [5, "high"],
    ]);
    expect(f[0]!.evidence).toBe(".btn:focus { outline: none }");
    expect(f[0]!.wcag).toEqual(["2.4.7"]);
    expect(f[0]!.message).toMatch(/keyboard users cannot see/);
  });

  it("accepts replacements: same rule, :focus-visible, mixins, :focus-within and :has() on a wrapper", () => {
    const ok = [
      `.btn:focus { outline: none; box-shadow: 0 0 0 3px blue }`,
      `button { outline: none } button:focus-visible { outline: 2px solid }`,
      `.tab:focus { outline: none } .tab:focus-visible { border-color: blue }`,
      `.x:focus-visible { outline: 0; @include focus-ring(true) }`,
      `.range:focus-visible { outline: 0; &::-webkit-slider-thumb { box-shadow: 0 0 0 2px } }`,
      `.switch { input[type=checkbox] { outline: 0 } &:focus-within { box-shadow: 0 0 0 2px } }`,
      `.root:has(.link:focus-visible) { outline: 2px solid } .link:focus-visible { outline: none }`,
      `.cal button { outline: none } .cal__tile:enabled:focus { background: #eee }`,
      `.n:focus-visible { outline: 2px solid color-mix(in oklab, var(--accent), transparent 70%) }`,
      `.e:focus { @apply scale-110 }\n.e { @apply outline-none }`,
    ];
    for (const src of ok) expect(lines("a.scss", src), src).toEqual([]);
  });

  it("skips the keyboard-only pattern, programmatic focus targets, text fields, hover and generated CSS", () => {
    const quiet = [
      `:focus:not(:focus-visible) { outline: none }`,
      `button::-moz-focus-inner { border: 0 }`,
      `[tabindex="-1"]:focus { outline: 0 !important }`,
      `.search-input:focus, textarea:focus, input[type=text] { outline: none }`,
      `a:active, a:hover { outline: 0 }`,
      `.container:focus-within { outline: none }`,
      `.focus\\:outline-none:focus { outline-style: none }`,
      `/*! tailwindcss v3.4.1 | MIT License */ .btn:focus { outline: none }`,
    ];
    for (const src of quiet) expect(lines("a.css", src), src).toEqual([]);
  });

  it("checks <style> blocks in Vue, Svelte, Astro and HTML at their real line numbers", () => {
    expect(lines("C.vue", `<template><p>x</p></template>\n<style scoped>\n.a {}\n.btn:focus { outline: none }\n</style>`)).toEqual([4]);
    expect(lines("C.svelte", `<button>x</button>\n<style lang="scss">\n.x { &:focus { outline: 0 } }\n</style>`)).toEqual([3]);
    expect(lines("C.vue", `<style lang="sass">\n.x:focus\n  outline: none\n</style>`)).toEqual([]);
  });

  it("honors suppression comments and the --rules filter", () => {
    expect(lines("a.css", `/* wcag-audit-ignore focus-outline-removed */\n.btn:focus { outline: none }`)).toEqual([]);
    expect(analyzeSource("a.css", `.btn:focus { outline: none }`, { rules: ["img-alt"] })).toEqual([]);
  });

  it("scans .css / .scss / .less files in directories, and the clean fixture stays clean", async () => {
    const r = await scanStatic(path.join(__dirname, "fixtures/static/good/styles.scss"));
    expect(r.findings).toEqual([]);
  });
});

describe("focus-outline-removed (2.4.7) in class names", () => {
  it("reports outline-none / focus:outline-none on focusable elements without a focus class", () => {
    const src = `export const A = () => <>
  <button className="outline-none">x</button>
  <a href="/" className="focus-visible:outline-none">y</a>
  <div role="button" tabIndex={0} className="focus:outline-none">z</div>
  <button className={cn("outline-none px-2", active && "bg-blue-500")}>w</button>
</>;`;
    expect(find("a.tsx", src).map((f) => [f.location.line, f.confidence])).toEqual([
      [2, "high"],
      [3, "high"],
      [4, "high"],
      [5, "medium"],
    ]);
    expect(lines("a.vue", `<template><button class="focus:outline-none">x</button></template>`)).toEqual([1]);
  });

  it("accepts focus rings, wrappers, peers, groups and conditional rings", () => {
    const ok = [
      `const A = () => <button className="focus:outline-none focus:ring-2">x</button>;`,
      `const A = () => <button className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2">x</button>;`,
      `const A = () => <div className="focus-within:ring-2"><button className="outline-none">x</button></div>;`,
      `const A = () => <button className="group/resize outline-none"><span className="opacity-0 group-focus-visible/resize:opacity-100" /></button>;`,
      "const A = () => <div className={`outline-none ${focused ? 'focus:ring-2' : ''}`} tabIndex={0}>x</div>;",
      `const A = () => <li role="option" tabIndex={0} className="outline-none data-highlighted:bg-accent">x</li>;`,
    ];
    for (const src of ok) expect(lines("a.tsx", src), src).toEqual([]);
  });

  it("skips components, text fields, composite widgets, non-focusable and programmatically focused elements", () => {
    const quiet = [
      `const A = () => <DropdownMenuItem className="outline-none">x</DropdownMenuItem>;`,
      `const A = () => <input className="outline-none" aria-label="Search" />;`,
      `const A = () => <textarea className="focus:outline-none" aria-label="Note" />;`,
      `const A = () => <div role="listbox" tabIndex={0} className="outline-none">x</div>;`,
      `const A = () => <div className="outline-none">x</div>;`,
      `const A = () => <div tabIndex={-1} className="outline-none">x</div>;`,
      `const A = () => <button className={classes}>x</button>;`,
    ];
    for (const src of quiet) expect(lines("a.tsx", src), src).toEqual([]);
    expect(lines("a.svelte", `<button tabindex={-1} class="outline-none">x</button>`)).toEqual([]);
  });
});
