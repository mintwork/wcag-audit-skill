import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/runtime/browser.js";
import { filterStories, scanStorybook, storiesFromIndex } from "../src/runtime/storybook.js";
import { verifyReport } from "../src/scan.js";

const run = promisify(execFile);
const CLI = path.join(__dirname, "../dist/cli.js");
const SB = path.join(__dirname, "fixtures/storybook");
let browserOk = true;
let server: http.Server;
let base = "";

beforeAll(async () => {
  try {
    await (await launchBrowser()).close();
  } catch (e) {
    browserOk = false;
    console.warn(`[storybook tests skipped] ${(e as Error).message.split("\n")[0]}`);
  }
  // A "running Storybook": serves the fixture; stories.json is the 6.x index (no index.json).
  server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://x").pathname);
    try {
      if (name === "index.json") return void res.writeHead(404).end();
      const file = name === "stories.json" ? "index.json" : name;
      let body = await readFile(path.join(SB, file), "utf8");
      if (name === "stories.json") body = JSON.stringify({ v: 3, stories: JSON.parse(body).entries });
      res.writeHead(200, { "content-type": name.endsWith(".json") ? "application/json" : "text/html" }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("Storybook index", () => {
  it("reads index.json (v4/v5) and stories.json (v3), skipping docs entries", async () => {
    const v5 = JSON.parse(await readFile(path.join(SB, "index.json"), "utf8"));
    expect(storiesFromIndex(v5).map((s) => s.id)).toEqual(["button--primary", "button--icon-only", "forms-signup--default"]);
    expect(storiesFromIndex({ v: 3, stories: { "a--b": { id: "a--b", kind: "A", name: "B" } } })).toEqual([{ id: "a--b", title: "A", name: "B" }]);
    expect(() => storiesFromIndex({ foo: 1 })).toThrow(/not a Storybook index/);
  });

  it("filters by id or title substrings", () => {
    const stories = [
      { id: "button--primary", title: "Button", name: "Primary" },
      { id: "forms-signup--default", title: "Forms/Signup", name: "Default" },
    ];
    expect(filterStories(stories, "forms/").map((s) => s.id)).toEqual(["forms-signup--default"]);
    expect(filterStories(stories, "PRIMARY, nope").map((s) => s.id)).toEqual(["button--primary"]);
    expect(filterStories(stories, "")).toHaveLength(2);
  });
});

describe("scanning stories", () => {
  it("scans every story of a static build, excluding Storybook's own UI, with stable ids", async (ctx) => {
    if (!browserOk) ctx.skip();
    const a = await scanStorybook(SB, { keyboard: false });
    expect(a.map((r) => [r.story?.id, r.findings.map((f) => f.ruleId)])).toEqual([
      ["button--primary", []],
      ["button--icon-only", ["axe/button-name"]],
      ["forms-signup--default", ["axe/label"]],
    ]);
    expect(a[1]!.findings[0]!.location.url).toBe(`${SB}/iframe.html?id=button--icon-only&viewMode=story`);
    // A static build is served on a random port; ids must not depend on it.
    const b = await scanStorybook(SB, { keyboard: false, stories: "icon" });
    expect(b.map((r) => r.story?.id)).toEqual(["button--icon-only"]);
    expect(b[0]!.findings[0]!.id).toBe(a[1]!.findings[0]!.id);
    // verify re-scans the story.
    const res = await verifyReport({ scans: [a[1]!] }, { keyboard: false });
    expect([res.remaining.length, res.resolved.length, res.introduced.length]).toEqual([1, 0, 0]);
  });

  it("CLI: --storybook against a running Storybook 6 (stories.json)", async (ctx) => {
    if (!browserOk) ctx.skip();
    const { stdout } = await run("node", [CLI, "scan", "--storybook", base, "--stories", "forms", "--json", "--fail-on", "none", "--no-keyboard"]);
    const r = JSON.parse(stdout);
    expect(r.scans.map((s: { target: string }) => s.target)).toEqual([`${base}/iframe.html?id=forms-signup--default&viewMode=story`]);
    expect(r.scans[0].findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(["axe/label"]);
    const text = await run("node", [CLI, "scan", "--storybook", base, "--stories", "forms", "--fail-on", "none", "--no-keyboard"]);
    expect(text.stdout).toContain("Story Forms/Signup / Default");
  });

  it("explains a missing index or an empty selection", async (ctx) => {
    if (!browserOk) ctx.skip();
    await expect(scanStorybook(path.join(__dirname, "fixtures/runtime"))).rejects.toThrow(/no Storybook index/);
    await expect(scanStorybook(SB, { stories: "nothing-matches" })).rejects.toThrow(/no stories match/);
  });
});
