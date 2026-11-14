import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchBrowser } from "../src/runtime/browser.js";
import { scanUrl } from "../src/runtime/scan-url.js";
import { jobsFromConfig, loadRuntimeConfig } from "../src/runtime/states.js";
import { verifyReport } from "../src/scan.js";

const run = promisify(execFile);
const CLI = path.join(__dirname, "../dist/cli.js");
const FIX = path.join(__dirname, "fixtures/runtime");
let server: http.Server;
let base = "";
let browserOk = true;

beforeAll(async () => {
  try {
    await (await launchBrowser()).close();
  } catch (e) {
    browserOk = false;
    console.warn(`[runtime state tests skipped] ${(e as Error).message.split("\n")[0]}`);
  }
  server = http.createServer(async (req, res) => {
    const name = path.basename(new URL(req.url ?? "/", "http://x").pathname);
    // The private page needs a session cookie (set via storage state); without it, go to the public page.
    if (name === "private.html" && !/(^|;\s*)session=ok/.test(req.headers.cookie ?? "")) return void res.writeHead(302, { location: "/good.html" }).end();
    try {
      const body = await readFile(path.join(FIX, name));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ids = (r: { findings: { ruleId: string }[] }) => [...new Set(r.findings.map((f) => f.ruleId))].sort();

describe("runtime states", () => {
  it("the default state is clean; each state surfaces its own violations", async (ctx) => {
    if (!browserOk) ctx.skip();
    const url = `${base}/states.html`;
    expect((await scanUrl(url)).findings).toEqual([]);
    const modal = await scanUrl(url, { state: { name: "dialog open", steps: [{ click: "#open" }, { waitFor: "#dialog:not([hidden])" }] } });
    expect(ids(modal)).toEqual(["axe/label"]);
    expect(modal.findings[0]!.location).toMatchObject({ url, selector: "#nickname", state: "dialog open" });
    expect(modal.state?.name).toBe("dialog open");
    const submit = await scanUrl(url, { state: { name: "empty submit", steps: [{ click: "button[type=submit]" }] } });
    expect(ids(submit)).toEqual(["axe/color-contrast"]);
    expect(ids(await scanUrl(url, { state: { name: "dark", colorScheme: "dark" } }))).toEqual(["axe/color-contrast"]);
    expect(ids(await scanUrl(url, { state: { name: "320px", viewport: { width: 320, height: 640 } } }))).toEqual(["axe/button-name"]);
  });

  it("state names are part of finding ids, and verify replays the state", async (ctx) => {
    if (!browserOk) ctx.skip();
    const url = `${base}/states.html`;
    const dark = await scanUrl(url, { state: { name: "dark", colorScheme: "dark" }, keyboard: false });
    const dim = await scanUrl(url, { state: { name: "dim", colorScheme: "dark" }, keyboard: false });
    expect(dark.findings[0]!.id).not.toBe(dim.findings[0]!.id);
    const res = await verifyReport({ scans: [dark] }, { keyboard: false });
    expect(res.remaining.map((f) => f.ruleId)).toEqual(["axe/color-contrast"]);
    expect(res.introduced).toEqual([]);
  });

  it("a failing step names the step", async (ctx) => {
    if (!browserOk) ctx.skip();
    await expect(scanUrl(`${base}/states.html`, { state: { name: "x", steps: [{ click: "#missing" }] }, timeoutMs: 500 })).rejects.toThrow(/step 1 \({"click":"#missing"}\) failed/);
  });

  it("authenticated pages via Playwright storage state", async (ctx) => {
    if (!browserOk) ctx.skip();
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-auth-"));
    const state = path.join(dir, "state.json");
    const host = new URL(base).hostname;
    await writeFile(state, JSON.stringify({ cookies: [{ name: "session", value: "ok", domain: host, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }));
    expect((await scanUrl(`${base}/private.html`)).findings).toEqual([]); // redirected to the public page
    expect(ids(await scanUrl(`${base}/private.html`, { storageState: state }))).toEqual(["axe/image-alt"]);
  });

  it("CLI: --config runs pages × states in one browser; --storage-state and --viewport flags", async (ctx) => {
    if (!browserOk) ctx.skip();
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-config-"));
    const host = new URL(base).hostname;
    await writeFile(path.join(dir, "auth.json"), JSON.stringify({ cookies: [{ name: "session", value: "ok", domain: host, path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] }));
    await writeFile(
      path.join(dir, "wcag.json"),
      JSON.stringify({
        baseUrl: base,
        storageState: "auth.json",
        states: [{ name: "dark", colorScheme: "dark" }],
        pages: [{ url: "/states.html", states: [{ name: "dialog open", steps: [{ click: "#open" }] }] }, "/private.html"],
      }),
    );
    const cfg = await loadRuntimeConfig(path.join(dir, "wcag.json"));
    expect(jobsFromConfig(cfg).map((j) => `${new URL(j.url).pathname} ${j.state?.name ?? "default"}`)).toEqual([
      "/states.html default",
      "/states.html dark",
      "/states.html dialog open",
      "/private.html default",
      "/private.html dark",
    ]);
    const { stdout } = await run("node", [CLI, "scan", "--config", "wcag.json", "--json", "--fail-on", "none", "--no-keyboard"], { cwd: dir });
    const report = JSON.parse(stdout);
    const seen = report.scans.flatMap((s: { findings: { ruleId: string; location: { url: string; state?: string } }[] }) =>
      s.findings.map((f) => `${new URL(f.location.url).pathname} ${f.location.state ?? "default"} ${f.ruleId}`),
    );
    expect([...new Set(seen)].sort()).toEqual(["/private.html dark axe/image-alt", "/private.html default axe/image-alt", "/states.html dark axe/color-contrast", "/states.html dialog open axe/label"]);
    const narrow = await run("node", [CLI, "scan", `${base}/states.html`, "--viewport", "320x640", "--json", "--fail-on", "none", "--no-keyboard"], { cwd: dir });
    expect(JSON.parse(narrow.stdout).scans[0].findings.map((f: { ruleId: string }) => f.ruleId)).toEqual(["axe/button-name"]);
  });
});

describe("config validation", () => {
  const write = async (obj: unknown) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-cfg-"));
    const file = path.join(dir, "c.json");
    await writeFile(file, typeof obj === "string" ? obj : JSON.stringify(obj));
    return file;
  };

  it("explains what is wrong", async () => {
    await expect(loadRuntimeConfig(await write("{"))).rejects.toThrow(/not valid JSON/);
    await expect(loadRuntimeConfig(await write({}))).rejects.toThrow(/"pages" must be a non-empty array/);
    await expect(loadRuntimeConfig(await write({ pages: ["/a"] }))).rejects.toThrow(/"baseUrl" is required/);
    await expect(loadRuntimeConfig(await write({ baseUrl: "http://x", pages: ["/"], states: [{ name: "a", steps: [{ tap: "#x" }] }] }))).rejects.toThrow(/steps\[0\] must have one of: click/);
    await expect(loadRuntimeConfig(await write({ baseUrl: "http://x", pages: ["/"], states: [{ name: "a", colorScheme: "sepia" }] }))).rejects.toThrow(/colorScheme/);
    await expect(loadRuntimeConfig(await write({ baseUrl: "http://x", pages: ["/"], states: [{ name: "a", steps: [{ fill: "#e" }] }] }))).rejects.toThrow(/needs a string "value"/);
    const dup = await loadRuntimeConfig(await write({ baseUrl: "http://x", pages: [{ url: "/", states: [{ name: "dark" }] }], states: [{ name: "dark" }] }));
    expect(() => jobsFromConfig(dup)).toThrow(/defined twice/);
  });
});
