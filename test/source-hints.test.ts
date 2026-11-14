import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatSarif, formatText } from "../src/report/index.js";
import { launchBrowser } from "../src/runtime/browser.js";
import { scanUrl } from "../src/runtime/scan-url.js";
import { addSourceHints, handlesFor } from "../src/runtime/source-hints.js";
import type { Finding, ScanResult } from "../src/types.js";

const finding = (evidence: string, selector = "x"): Finding => ({
  id: "x",
  ruleId: "axe/button-name",
  source: "runtime",
  title: "t",
  wcag: ["4.1.2"],
  level: "A",
  severity: "critical",
  confidence: "high",
  location: { url: "http://localhost/", selector },
  evidence,
  message: "m",
  fix: "f",
});
const result = (findings: Finding[]): ScanResult => ({ tool: { name: "t", version: "0" }, target: "http://localhost/", kind: "runtime", startedAt: "", durationMs: 0, findings, discarded: 0 });

async function project(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-hints-"));
  for (const [name, src] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), src);
  }
  return dir;
}

describe("handles", () => {
  it("prefers test ids, then ids and labels, then project classes and text; skips utilities and generated ids", () => {
    const h = handlesFor(finding(`<button data-testid="pay" id="pay-btn" aria-label="Pay order" class="px-4 text-sm CheckoutForm__submit">Pay</button>`));
    expect(h.map((x) => [x.label, x.weight])).toEqual([
      ['data-testid="pay"', 10],
      ['id="pay-btn"', 7],
      ['aria-label="Pay order"', 5],
      ['text "Pay"', 4],
      ['class "CheckoutForm__submit"', 3],
    ]);
    expect(handlesFor(finding(`<div id="radix-:r3:" class="flex items-center">x</div>`))).toEqual([]);
    expect(handlesFor(finding(`<input id="headlessui-input-12">`, "#headlessui-input-12"))).toEqual([]);
  });
});

describe("addSourceHints", () => {
  it("points at the file and line with the strongest handle, as a hint", async () => {
    const dir = await project({
      "src/Checkout.tsx": `export function Checkout() {\n  return (\n    <form>\n      <button data-testid="pay" className="px-4"><LockIcon /></button>\n    </form>\n  );\n}`,
      "src/Other.tsx": `export const Other = () => <p>Pay</p>;`,
      "src/Banner.vue": `<template>\n  <img class="promo-banner__image" src="/promo.png">\n</template>`,
    });
    const pay = finding(`<button data-testid="pay" class="px-4"><svg></svg></button>`);
    const banner = finding(`<img class="promo-banner__image" src="/promo.png">`);
    const vague = finding(`<div class="flex">Pay</div>`);
    const r = [result([pay, banner, vague])];
    expect(await addSourceHints(r, "src", { cwd: dir })).toBe(1);
    expect(pay.sourceHint).toEqual({ file: "src/Checkout.tsx", line: 4, via: ['data-testid="pay"'] });
    expect(banner.sourceHint).toBeUndefined(); // one weak handle (a class) is not enough
    expect(vague.sourceHint).toBeUndefined();
    expect(formatText(r)).toContain('source (hint): src/Checkout.tsx:4 via data-testid="pay"');
    const sarif = JSON.parse(formatSarif(r));
    expect(sarif.runs[0].results.find((x: { relatedLocations?: unknown }) => x.relatedLocations).relatedLocations[0].physicalLocation.artifactLocation.uri).toBe("src/Checkout.tsx");
  });

  it("combines weaker handles, and refuses ambiguous matches", async () => {
    const dir = await project({
      "src/Search.tsx": `export const Search = () => <input className="SearchBox__input" placeholder="Search products" />;`,
      "src/A.tsx": `export const A = () => <button id="save">Save</button>;`,
      "src/B.tsx": `export const B = () => <button id="save">Save</button>;`,
    });
    const search = finding(`<input class="SearchBox__input" placeholder="Search products">`);
    const save = finding(`<button id="save">Save</button>`, "#save");
    await addSourceHints([result([search, save])], "src", { cwd: dir });
    expect(search.sourceHint).toEqual({ file: "src/Search.tsx", line: 1, via: ['placeholder="Search products"', 'class "SearchBox__input"'] });
    expect(save.sourceHint).toBeUndefined(); // same id in two files
  });
});

describe("end to end (browser)", () => {
  let server: http.Server;
  let base = "";
  let browserOk = true;
  beforeAll(async () => {
    try {
      await (await launchBrowser()).close();
    } catch {
      browserOk = false;
    }
    server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><html lang="en"><head><title>Shop</title></head><body><main><h1>Cart</h1>
<button type="button" data-testid="remove-item" class="CartRow__remove" style="width:44px;height:44px"><svg width="16" height="16" aria-hidden="true"></svg></button></main></body></html>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("maps an axe finding to the component that renders it", async (ctx) => {
    if (!browserOk) ctx.skip();
    const dir = await project({ "src/CartRow.tsx": `export function CartRow({ onRemove }) {\n  return <button type="button" data-testid="remove-item" className="CartRow__remove" onClick={onRemove}><TrashIcon aria-hidden /></button>;\n}` });
    const r = await scanUrl(base, { keyboard: false });
    expect(r.findings.map((f) => f.ruleId)).toEqual(["axe/button-name"]);
    await addSourceHints([r], "src", { cwd: dir });
    expect(r.findings[0]!.sourceHint).toEqual({ file: "src/CartRow.tsx", line: 2, via: ['data-testid="remove-item"', 'class "CartRow__remove"'] });
  });
});
