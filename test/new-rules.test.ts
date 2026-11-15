/** Rules added in the 0.2 line: autocomplete-valid, label-in-name, table-headers, duplicate-id-ref, tailwind-contrast. */
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/static/analyze.js";
import { invalidAutocomplete } from "../src/static/more-rules.js";
import { contrastRatio } from "../src/static/tailwind.js";

const find = (file: string, src: string, rule: string) => analyzeSource(file, src, { rules: [rule] });
const ids = (file: string, src: string, rule: string) => find(file, src, rule).map((f) => f.ruleId);

describe("autocomplete-valid (1.3.5)", () => {
  it("accepts valid autofill values", () => {
    for (const v of ["on", "off", "email", "new-password", "shipping postal-code", "section-a billing cc-number", "work email", "home tel webauthn", "username webauthn"])
      expect(invalidAutocomplete(v), v).toBeUndefined();
    for (const v of ["", "emial", "work name", "billing", "email email", "section- email"]) expect(invalidAutocomplete(v), v).not.toBeUndefined();
  });

  it("suggests the intended token for typos and common aliases", () => {
    const [typo] = find("a.html", `<input autocomplete="emial" aria-label="Email">`, "autocomplete-valid");
    expect([typo!.confidence, typo!.fix]).toEqual(["high", 'Use autocomplete="email".']);
    expect(find("a.tsx", `const A = () => <input autoComplete="firstname" aria-label="First name" />;`, "autocomplete-valid")[0]!.fix).toContain('"given-name"');
    expect(find("a.html", `<input autocomplete="work name" aria-label="Name">`, "autocomplete-valid")[0]!.fix).toBe('Use autocomplete="name".');
  });

  it("reports autofill-off hacks at medium confidence", () => {
    const [f] = find("a.html", `<input type="search" autocomplete="false" aria-label="Filter">`, "autocomplete-valid");
    expect([f!.confidence, f!.severity]).toEqual(["medium", "moderate"]);
    expect(f!.fix).toContain('autocomplete="off"');
  });

  it("skips bound values, components, non-text inputs and forms", () => {
    expect(ids("a.vue", `<template><input :autocomplete="ac" aria-label="x"></template>`, "autocomplete-valid")).toEqual([]);
    expect(ids("a.tsx", `const A = () => <TextField autoComplete="nope" />;`, "autocomplete-valid")).toEqual([]);
    expect(ids("a.html", `<input type="checkbox" autocomplete="nope" aria-label="x"><form autocomplete="off"></form>`, "autocomplete-valid")).toEqual([]);
  });
});

describe("label-in-name (2.5.3)", () => {
  it("reports aria-label that does not contain the visible text", () => {
    const [f] = find("a.tsx", `const A = () => <button aria-label="Open navigation">Menu</button>;`, "label-in-name");
    expect([f!.confidence, f!.message]).toEqual(["high", expect.stringContaining('"Menu"')]);
    expect(ids("a.html", `<a href="/in" aria-label="Log in">Sign in</a><input type="submit" value="Send" aria-label="Submit form">`, "label-in-name")).toHaveLength(2);
  });

  it("reports reordered words at medium confidence", () => {
    expect(find("a.html", `<button aria-label="Add Blue Shirt to cart">Add to cart</button>`, "label-in-name")[0]!.confidence).toBe("medium");
  });

  it("accepts names that contain the visible text, or are contained in it", () => {
    const ok = [
      `<a href="/p" aria-label="Read more about pricing">Read more</a>`,
      `<button aria-label="Close dialog">×</button>`,
      `<button aria-label="Search">Search <span class="sr-only">the site</span></button>`,
      `<button aria-label="Ask AI"><b>Ask AI</b> <span>Find anything in your data</span></button>`,
      `<button aria-label="Next, page 2">next</button>`,
      `<button aria-labelledby="x" aria-label="Other">Menu</button>`,
    ];
    for (const src of ok) expect(ids("a.html", src, "label-in-name"), src).toEqual([]);
  });

  it("skips dynamic text, components and responsive-hidden text", () => {
    expect(ids("a.tsx", `const A = () => <button aria-label="Close">{label}</button>;`, "label-in-name")).toEqual([]);
    expect(ids("a.tsx", `const A = () => <button aria-label="Close"><Trans id="x" /></button>;`, "label-in-name")).toEqual([]);
    expect(ids("a.tsx", `const A = () => <button aria-label="Settings"><span className="hidden md:inline">Preferences</span></button>;`, "label-in-name")).toEqual([]);
  });
});

describe("table-headers (1.3.1)", () => {
  it("reports a header row marked up with <td> (high) and header-less data tables (medium)", () => {
    const thead = `const T = () => <table><thead><tr><td>Name</td><td>Split</td></tr></thead><tbody>{rows.map((r) => <tr><td>{r.n}</td><td>{r.s}</td></tr>)}</tbody></table>;`;
    expect(find("t.tsx", thead, "table-headers").map((f) => f.confidence)).toEqual(["high"]);
    const grid = `<table><tr><td>Name</td><td>Age</td></tr><tr><td>Ann</td><td>3</td></tr></table>`;
    expect(find("t.html", grid, "table-headers").map((f) => f.confidence)).toEqual(["medium"]);
  });

  it("accepts th, scope, header roles, layout tables and tables it cannot see", () => {
    const ok = [
      `<table><tr><th>Name</th><th>Age</th></tr><tr><td>Ann</td><td>3</td></tr></table>`,
      `<table><tr><td scope="row">Name</td><td>Ann</td></tr><tr><td scope="row">Age</td><td>3</td></tr></table>`,
      `<table role="presentation"><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>`,
      `<table><tr><td>only</td></tr></table>`,
      `<table><tr><td><table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table></td><td>x</td></tr><tr><td>y</td><td>z</td></tr></table>`,
    ];
    for (const src of ok) expect(ids("t.html", src, "table-headers"), src).toEqual([]);
    expect(ids("t.tsx", `const T = () => <table><TableHeader /><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>;`, "table-headers")).toEqual([]);
    expect(ids("t.tsx", `const T = () => <table><thead>{renderHead()}</thead><tbody><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></tbody></table>;`, "table-headers")).toEqual([]);
  });
});

describe("duplicate-id-ref (1.3.1, 4.1.2)", () => {
  it("reports duplicate ids that a label or ARIA reference points to", () => {
    const [f] = find("d.html", `<label for="email">Email</label>\n<input id="email">\n<input id="email">`, "duplicate-id-ref");
    expect(f!.location.line).toBe(3);
    expect(f!.message).toMatch(/also used on line 2/);
    expect(ids("d.vue", `<template><div><p id="hint">Hint</p><p id="hint">Other</p><input aria-describedby="hint" aria-label="x"></div></template>`, "duplicate-id-ref")).toHaveLength(1);
  });

  it("ignores unreferenced duplicates, exclusive branches and separate components", () => {
    expect(ids("d.html", `<div id="a"></div><div id="a"></div>`, "duplicate-id-ref")).toEqual([]);
    expect(ids("d.vue", `<template><input v-if="a" id="q" aria-label="a"><input v-else id="q" aria-label="b"><label for="q">Q</label></template>`, "duplicate-id-ref")).toEqual([]);
    expect(ids("d.svelte", `{#if a}<input id="q">{:else}<input id="q">{/if}<label for="q">Q</label>`, "duplicate-id-ref")).toEqual([]);
    const two = `function A() { return <form><label htmlFor="e">E</label><input id="e" /></form>; }
function B() { return <form><label htmlFor="e">E</label><input id="e" /></form>; }
function C() { return <div>{x ? <input id="q" /> : <input id="q" />}<label htmlFor="q">Q</label></div>; }`;
    expect(ids("d.tsx", two, "duplicate-id-ref")).toEqual([]);
    expect(ids("d.html", `<template><input id="t"></template><input id="t"><label for="t">T</label>`, "duplicate-id-ref")).toEqual([]);
  });
});

describe("tailwind-contrast (1.4.3)", () => {
  it("computes WCAG contrast ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("reports text-* on bg-* below 4.5:1 (3:1 for large text), at medium confidence", () => {
    const src = `const A = () => <div className="bg-white"><p className="text-gray-400">Muted</p><h2 className="text-2xl text-gray-400">Big</h2><h2 className="text-2xl text-gray-500">Big ok</h2></div>;`;
    const f = find("a.tsx", src, "tailwind-contrast");
    expect(f.map((x) => [x.evidence, x.confidence])).toEqual([
      ['<p className="text-gray-400">', "medium"],
      ['<h2 className="text-2xl text-gray-400">', "medium"],
    ]);
    expect(f[0]!.message).toMatch(/text-gray-400 on bg-white .* 2\.\d+:1/);
    expect(f[1]!.message).toMatch(/large text needs at least 3:1/);
    expect(ids("b.html", `<button class="bg-blue-500 text-white">Save</button><span class="bg-[#fff] text-[#aaa]">x</span>`, "tailwind-contrast")).toHaveLength(2);
    expect(find("c.vue", `<template><div class="bg-gray-900"><p class="text-gray-600">Dim</p></div></template>`, "tailwind-contrast")[0]!.fix).toMatch(/lighter text color \(e\.g\. text-gray-400\)/);
  });

  it("stays quiet unless both colors are statically known", () => {
    const quiet = [
      `const A = () => <div className={cn("bg-white")}><p className="text-gray-400">x</p></div>;`, // bound class
      `const A = () => <Card><p className="text-gray-300">x</p></Card>;`, // background from a component
      `const A = () => <div className="bg-primary"><p className="text-gray-300">x</p></div>;`, // theme color
      `const A = () => <div className="bg-white/80"><p className="text-gray-300">x</p></div>;`, // alpha
      `const A = () => <div className="bg-white"><p className="text-gray-300/50">x</p></div>;`,
      `const A = () => <div className="bg-white opacity-50"><p className="text-gray-700">x</p></div>;`,
      `const A = () => <div className="bg-gradient-to-r from-white"><p className="text-gray-300">x</p></div>;`,
      `const A = () => <p className="text-gray-300">no background known</p>;`,
      `const A = () => <div className="bg-white"><button disabled className="text-gray-300">Off</button></div>;`, // inactive
      `const A = () => <div className="bg-white"><span className="text-gray-300">·</span></div>;`, // separator
      `const A = () => <div className="bg-white"><p className="text-gray-300 sr-only">x</p></div>;`,
      `const A = () => <div className="bg-white" style={s}><p className="text-gray-300">x</p></div>;`,
      `const A = () => <div className="bg-white hover:bg-gray-50"><p className="text-gray-700 dark:text-gray-400">x</p></div>;`,
    ];
    for (const src of quiet) expect(ids("a.tsx", src, "tailwind-contrast"), src).toEqual([]);
  });

  it("only reports a pair once and passes when either palette version passes", () => {
    const src = `const A = () => <div className="bg-white text-gray-400"><span>a</span> b <span>c</span></div>;`;
    expect(ids("a.tsx", src, "tailwind-contrast")).toHaveLength(1);
    // gray-500 on white: 4.83 (v3) / 4.84 (v4) passes.
    expect(ids("a.tsx", `const A = () => <p className="bg-white text-gray-500">ok</p>;`, "tailwind-contrast")).toEqual([]);
  });
});
