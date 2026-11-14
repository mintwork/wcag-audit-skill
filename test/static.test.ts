import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource, scanStatic } from "../src/static/analyze.js";
import { rules } from "../src/static/rules.js";

const FIX = path.join(__dirname, "fixtures/static");

const ruleIds = (findings: { ruleId: string }[]) => [...new Set(findings.map((f) => f.ruleId))].sort();

describe("static scan: known-bad fixtures", () => {
  it("HTML page", async () => {
    const r = await scanStatic(path.join(FIX, "bad/page.html"));
    expect(ruleIds(r.findings)).toEqual(
      [
        "anchor-is-button",
        "aria-attr-valid",
        "aria-hidden-focusable",
        "aria-role-valid",
        "button-name",
        "document-title",
        "empty-heading",
        "form-label",
        "heading-order",
        "html-lang",
        "iframe-title",
        "img-alt",
        "img-alt-meaningful",
        "input-image-alt",
        "link-name",
        "link-text-vague",
        "meta-viewport-zoom",
        "no-autofocus",
        "no-distracting-elements",
        "no-div-button",
        "no-positive-tabindex",
        "svg-img-name",
        "video-captions",
      ].sort(),
    );
  });

  it("React TSX component", async () => {
    const r = await scanStatic(path.join(FIX, "bad/ProductCard.tsx"));
    const byRule = (id: string) => r.findings.filter((f) => f.ruleId === id).map((f) => f.location.line);
    expect(byRule("img-alt")).toEqual([11, 21, 22]); // <img>, next/image <Image>, conditional <img>
    expect(byRule("heading-order")).toEqual([13]);
    expect(byRule("no-div-button")).toEqual([14]);
    expect(byRule("form-label")).toEqual([15, 23]); // input + select
    expect(byRule("button-name")).toEqual([16]);
    expect(byRule("anchor-is-button")).toEqual([19]);
    expect(byRule("no-positive-tabindex")).toEqual([20]);
    expect(r.findings).toHaveLength(10);
  });

  it("Vue SFC (only the template is scanned)", async () => {
    const r = await scanStatic(path.join(FIX, "bad/Signup.vue"));
    expect(ruleIds(r.findings)).toEqual(["button-name", "form-label", "heading-order", "img-alt", "no-div-button"]);
    expect(r.findings.every((f) => f.location.line! < 11)).toBe(true);
  });

  it("Svelte component", async () => {
    const r = await scanStatic(path.join(FIX, "bad/Nav.svelte"));
    expect(ruleIds(r.findings)).toEqual(["form-label", "img-alt", "link-name", "no-div-button"]);
  });
});

describe("static scan: clean fixtures produce zero findings", () => {
  for (const file of ["page.html", "ProductCard.tsx", "Signup.vue", "Nav.svelte"]) {
    it(file, async () => {
      const r = await scanStatic(path.join(FIX, "good", file));
      expect(r.findings).toEqual([]);
    });
  }
});

describe("finding shape", () => {
  it("has WCAG criterion, severity, location, evidence and a fix", async () => {
    const r = await scanStatic(path.join(FIX, "bad/page.html"));
    for (const f of r.findings) {
      expect(f.id).toMatch(/^[0-9a-f]{12}(-\d+)?$/);
      expect(f.wcag.length).toBeGreaterThan(0);
      expect(["critical", "serious", "moderate", "minor"]).toContain(f.severity);
      expect(f.location.file).toContain("page.html");
      expect(f.location.line).toBeGreaterThan(0);
      expect(f.evidence.startsWith("<")).toBe(true);
      expect(f.fix.length).toBeGreaterThan(10);
    }
  });

  it("fingerprints are stable when lines move", () => {
    const a = analyzeSource("x.html", `<img src="a.png">`);
    const b = analyzeSource("x.html", `\n\n\n<img src="a.png">`);
    expect(a[0]!.id).toBe(b[0]!.id);
    expect(b[0]!.location.line).toBe(4);
  });

  it("every rule has metadata mapped to WCAG", () => {
    const ids = new Set<string>();
    for (const r of rules) {
      expect(ids.has(r.meta.id)).toBe(false);
      ids.add(r.meta.id);
      expect(r.meta.wcag.every((w) => /^\d\.\d\.\d+$/.test(w))).toBe(true);
    }
  });
});

describe("false-positive guards", () => {
  const run = (file: string, src: string) => analyzeSource(file, src).map((f) => f.ruleId);

  it("skips elements with spread props", () => {
    expect(run("a.tsx", `const A = (p) => <img {...p} />;`)).toEqual([]);
    expect(run("a.vue", `<template><img v-bind="attrs" /></template>`)).toEqual([]);
    expect(run("a.svelte", `<img {...$$restProps}>`)).toEqual([]);
  });

  it("treats bound values as present", () => {
    expect(run("a.tsx", `const A = () => <img src={s} alt={t("logo")} />;`)).toEqual([]);
    expect(run("a.vue", `<template><img :src="s" :alt="alt" /></template>`)).toEqual([]);
    expect(run("a.svelte", `<img src={s} {alt}>`)).toEqual([]);
    expect(run("a.html", `<img [src]="s" [alt]="alt">`)).toEqual([]);
  });

  it("button with dynamic or component content is not flagged", () => {
    expect(run("a.tsx", `const A = () => <button>{label}</button>;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <button><Trans id="save" /></button>;`)).toEqual([]);
    expect(run("a.vue", `<template><button>{{ label }}</button></template>`)).toEqual([]);
  });

  it("icon components do not count as a name unless labelled", () => {
    const f = analyzeSource("a.tsx", `const A = () => <button onClick={close}><XIcon /></button>;`);
    expect(f.map((x) => [x.ruleId, x.confidence])).toEqual([["button-name", "medium"]]);
    expect(run("a.tsx", `const A = () => <button><XIcon aria-label="Close" /></button>;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <a href="/"><Icon name="home" label={t("home")} /></a>;`)).toEqual([]);
  });

  it("does not parse markup in scripts, styles or comments", () => {
    expect(run("a.html", `<script>const x = "<img src=x>";</script><style>a{}</style><!-- <img src=y> -->`)).toEqual([]);
    expect(run("a.tsx", `// <img src="x">\nconst s = "<img src='x'>";`)).toEqual([]);
  });

  it("ignores TypeScript generics and comparisons", () => {
    expect(run("a.tsx", `const a = useState<boolean>(false); const b: Array<string> = []; if (x < y) {}`)).toEqual([]);
  });

  it("understands label association across frameworks", () => {
    expect(run("a.tsx", `const A = () => <><label htmlFor="e">Email</label><input id="e" /></>;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <><input aria-label="Email" /></>;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <label>Email <input /></label>;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <input type="hidden" name="csrf" />;`)).toEqual([]);
  });

  it("respects suppression comments", () => {
    expect(run("a.html", `<!-- wcag-audit-ignore img-alt -->\n<img src="x.png">`)).toEqual([]);
    expect(run("a.html", `<!-- wcag-audit-ignore link-name -->\n<img src="x.png">`)).toEqual(["img-alt"]);
    expect(run("a.html", `<!-- wcag-audit-ignore-file -->\n<img src="x.png">`)).toEqual([]);
    // The documented form, with a reason after a colon.
    expect(run("a.html", `<!-- wcag-audit-ignore img-alt: tracking pixel, hidden from AT -->\n<img src="x.png">`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <>\n{/* wcag-audit-ignore img-alt, link-name: decorative */}\n<img src="x.png" /></>;`)).toEqual([]);
    expect(run("a.html", `<!-- wcag-audit-ignore link-name: not this one -->\n<img src="x.png">`)).toEqual(["img-alt"]);
  });

  it("allows decorative images and dialog autofocus", () => {
    expect(run("a.html", `<img src="x.png" alt=""><img src="y.png" role="presentation">`)).toEqual([]);
    expect(run("a.html", `<dialog open><input aria-label="Name" autofocus></dialog>`)).toEqual([]);
  });

  it("skips live-stream videos and lowers confidence for script-filled HTML", () => {
    expect(run("a.html", `<video autoplay></video>`)).toEqual([]);
    const f = analyzeSource("a.html", `<a href="#" id="clear-all"></a><button></button>`);
    expect(f.map((x) => [x.ruleId, x.confidence])).toEqual([
      ["button-name", "high"],
      ["link-name", "medium"],
    ]);
  });

  it("explains unassociated sibling labels", () => {
    const [f] = analyzeSource("a.jsx", `const A = () => <div><label className="x">Region</label><input type="text" /></div>;`);
    expect(f!.ruleId).toBe("form-label");
    expect(f!.message).toMatch(/not associated/);
  });

  it("treats valueless JSX attributes as true and allows autofocus in dialog components", () => {
    expect(run("a.tsx", `const A = () => <div className="overlay" onClick={close} aria-hidden />;`)).toEqual([]);
    expect(run("a.tsx", `const A = () => <Dialog open><Button autoFocus>OK</Button></Dialog>;`)).toEqual([]);
  });

  it("allows aria role fallback lists", () => {
    expect(run("a.html", `<div role="switch checkbox" tabindex="0" aria-checked="false">x</div>`)).toEqual([]);
  });
});
