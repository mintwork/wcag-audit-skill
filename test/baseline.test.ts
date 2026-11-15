import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { applyBaseline, createBaseline, readBaseline } from "../src/baseline.js";
import { formatJson, formatText } from "../src/report/index.js";
import { scan } from "../src/scan.js";

const run = promisify(execFile);
const CLI = path.join(__dirname, "../dist/cli.js");
const BAD = path.join(__dirname, "fixtures/static/bad/Signup.vue");

async function cli(cwd: string, ...args: string[]) {
  try {
    const { stdout, stderr } = await run("node", [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

async function project() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-baseline-"));
  await cp(BAD, path.join(dir, "Signup.vue"));
  return dir;
}

describe("baseline", () => {
  it("hides known findings, keeps new ones and counts stale entries", async () => {
    const dir = await project();
    const before = await scan("Signup.vue", { cwd: dir });
    const known = new Set(createBaseline([before]).findings.map((f) => f.id));
    expect(known.size).toBe(before.findings.length);

    const file = path.join(dir, "Signup.vue");
    let src = await readFile(file, "utf8");
    src = src.replace('<img :src="logo" />', '<img :src="logo" alt="Acme" />'); // fixes img-alt
    src = src.replace("<h1>Sign up</h1>", '<h1>Sign up</h1>\n    <iframe src="/tos"></iframe>'); // new issue, lines move
    await writeFile(file, src);

    const after = await scan("Signup.vue", { cwd: dir });
    const res = applyBaseline([after], known);
    expect(after.findings.map((f) => f.ruleId)).toEqual(["iframe-title"]);
    expect(after.baselined).toBe(before.findings.length - 1);
    expect(res).toEqual({ known: before.findings.length - 1, stale: 1 });
    expect(JSON.parse(formatJson([after])).summary.baselined).toBe(before.findings.length - 1);
    expect(formatText([after])).toMatch(/known issues in the baseline not shown/);
  });

  it("accepts a --json report as the baseline", async () => {
    const dir = await project();
    const r = await scan("Signup.vue", { cwd: dir });
    const file = path.join(dir, "report.json");
    await writeFile(file, formatJson([r]));
    expect((await readBaseline(file)).size).toBe(r.findings.length);
    await writeFile(file, `{"nope":1}`);
    await expect(readBaseline(file)).rejects.toThrow(/not a .* baseline/);
    await expect(readBaseline(path.join(dir, "missing.json"))).rejects.toThrow(/--write-baseline/);
  });

  it("CLI: --write-baseline then --baseline fails only on new findings", async () => {
    const dir = await project();
    const w = await cli(dir, "scan", ".", "--write-baseline");
    expect(w.code).toBe(0);
    const baseline = JSON.parse(await readFile(path.join(dir, ".wcag-audit/baseline.json"), "utf8"));
    expect(baseline.version).toBe(1);
    expect(baseline.findings.length).toBeGreaterThan(3);
    expect(baseline.findings[0]).toEqual({ id: expect.any(String), ruleId: expect.any(String), where: "Signup.vue" });

    const clean = await cli(dir, "scan", ".", "--baseline", ".wcag-audit/baseline.json");
    expect(clean.code).toBe(0);
    expect(clean.stdout).toMatch(/No new accessibility issues/);

    const file = path.join(dir, "Signup.vue");
    await writeFile(file, (await readFile(file, "utf8")).replace("<h1>Sign up</h1>", '<h1>Sign up</h1><iframe src="/tos"></iframe>'));
    const dirty = await cli(dir, "scan", ".", "--baseline", ".wcag-audit/baseline.json", "--sarif");
    expect(dirty.code).toBe(1);
    expect(JSON.parse(dirty.stdout).runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toEqual(["iframe-title"]);

    const missing = await cli(dir, "scan", ".", "--baseline", "nope.json");
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/Baseline file not found/);
  });
});
