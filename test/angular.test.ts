import path from "node:path";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { analyzeSource, scanStatic } from "../src/static/analyze.js";
import { inlineTemplateRanges } from "../src/static/parse-angular.js";

const run = (src: string, file = "hero.component.ts") => analyzeSource(file, src).map((f) => `${f.ruleId}:${f.location.line}:${f.location.column}`);

describe("Angular inline templates", () => {
  it("scans template: strings in @Component at their real line and column", () => {
    const src = `import { Component } from "@angular/core";
@Component({
  selector: "app-x",
  template: \`
    <img src="a.png">
    <div (click)="go()">Go</div>
  \`,
})
export class X { html = "<img src='b.png'>"; }
@Component({ selector: "app-y", template: '<a href="/y"></a>' })
export class Y {}`;
    expect(run(src)).toEqual(["img-alt:5:5", "no-div-button:6:5", "link-name:10:44"]);
  });

  it("only reads literal templates in @Component, and handles escapes", () => {
    expect(inlineTemplateRanges(`@Component({ templateUrl: "./x.html" }) class A {}`)).toEqual([]);
    expect(inlineTemplateRanges("@Component({ template: `<p>${x}</p>` }) class A {}")).toEqual([]);
    expect(inlineTemplateRanges(`@Directive({ template: "<img>" }) class A {}`)).toEqual([]);
    expect(run("@Component({ template: `<p>It\\`s <img src=\"x\" alt=\"A \\`quoted\\` thing\"></p>` }) class A {}")).toEqual([]);
  });

  it("knows Angular template syntax: bindings, control flow, directives that render content", () => {
    const ok = `@Component({ template: \`
      <img [src]="p" [alt]="name">
      <button [attr.aria-label]="label"><i class="pi pi-x"></i></button>
      <button pButton label="Save" icon="pi pi-check"></button>
      @if (open) { <p>{{ text }}</p> }
      <div ngCombobox (click)="toggle()">Pick</div>
      <ul role="listbox"><li role="option" tabindex="-1" (keydown)="k()"><div (click)="choose()">One</div></li></ul>
    \` }) class A {}`;
    expect(run(ok)).toEqual([]);
    // A cosmetic directive (ripple) does not make a div operable.
    expect(run("@Component({ template: `<div pRipple (click)=\"go()\">Go</div>` }) class A {}")).toEqual(["no-div-button:1:25"]);
  });

  it("skips plain TypeScript and counts only component files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-ng-"));
    await mkdir(path.join(dir, "src"));
    await writeFile(path.join(dir, "src/util.ts"), `export const html = "<img src=x>";`);
    await writeFile(path.join(dir, "src/types.d.ts"), `declare const x: string;`);
    await writeFile(path.join(dir, "src/a.component.ts"), "@Component({ template: `<img src=\"a.png\">` }) export class A {}");
    const r = await scanStatic("src", { cwd: dir });
    expect(r.filesScanned).toBe(1);
    expect(r.findings.map((f) => f.ruleId)).toEqual(["img-alt"]);
  });

  it("the clean Angular fixture has no findings", async () => {
    const r = await scanStatic(path.join(__dirname, "fixtures/static/good/hero.component.ts"));
    expect(r.findings).toEqual([]);
  });
});
