import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { fixSource, fixViewportContent, normalizeLang, unifiedDiff } from "../src/fix.js";

const run = promisify(execFile);
const CLI = path.join(__dirname, "../dist/cli.js");

async function cli(cwd: string, ...args: string[]) {
  try {
    const { stdout, stderr } = await run("node", [CLI, ...args], { cwd, env: { ...process.env, FORCE_COLOR: "0" } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe("fix helpers", () => {
  it("repairs language tags only when it is mechanical", () => {
    expect(normalizeLang("en_US")).toBe("en-US");
    expect(normalizeLang("EN-us")).toBe("en-US");
    expect(normalizeLang("English")).toBe("en");
    expect(normalizeLang("zh_hant_tw")).toBe("zh-Hant-TW");
    expect(normalizeLang("klingon")).toBeUndefined();
    expect(normalizeLang("en")).toBeUndefined(); // already valid
  });

  it("drops only the zoom-blocking viewport tokens", () => {
    expect(fixViewportContent("width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no")).toBe("width=device-width, initial-scale=1");
    expect(fixViewportContent("width=device-width,user-scalable=0,maximum-scale=5")).toBe("width=device-width, maximum-scale=5");
  });
});

describe("fixSource", () => {
  it("fixes HTML: viewport, lang (only with --lang when missing) and aria typos", () => {
    const src = `<!doctype html>\n<html>\n<head><meta name="viewport" content="width=device-width, user-scalable=no"></head>\n<body><span aria-lable="Close">x</span></body>\n</html>\n`;
    const without = fixSource("a.html", src);
    expect(without.applied.map((a) => a.ruleId)).toEqual(["meta-viewport-zoom", "aria-attr-valid"]);
    expect(without.skipped).toEqual([{ ruleId: "html-lang", line: 2, reason: expect.stringMatching(/pass --lang/) }]);
    const withLang = fixSource("a.html", src, { lang: "de" });
    expect(withLang.after).toBe(`<!doctype html>\n<html lang="de">\n<head><meta name="viewport" content="width=device-width"></head>\n<body><span aria-label="Close">x</span></body>\n</html>\n`);
  });

  it("keeps binding prefixes and quotes, and works in JSX and Vue", () => {
    const vue = fixSource("a.vue", `<template><span :aria-lable="label" aria-labeledby='x'>x</span></template>`);
    expect(vue.after).toBe(`<template><span :aria-label="label" aria-labelledby='x'>x</span></template>`);
    const jsx = fixSource("l.tsx", `export default () => <html lang="en_us"><body aria-describdby={id}>{c}</body></html>;`);
    expect(jsx.after).toBe(`export default () => <html lang="en-US"><body aria-describedby={id}>{c}</body></html>;`);
  });

  it("leaves ambiguous or conflicting cases alone and respects suppressions", () => {
    expect(fixSource("a.html", `<button aria-hiden="true" aria-hidden="false">y</button>`).after).toBe(`<button aria-hiden="true" aria-hidden="false">y</button>`);
    expect(fixSource("a.html", `<span aria-foo="x">y</span>`).applied).toEqual([]);
    expect(fixSource("a.html", `<html lang="klingon"></html>`).skipped[0]!.reason).toMatch(/cannot be repaired/);
    const suppressed = `<!-- wcag-audit-ignore aria-attr-valid -->\n<span aria-lable="x">y</span>`;
    expect(fixSource("a.html", suppressed).after).toBe(suppressed);
  });
});

describe("unifiedDiff", () => {
  it("produces a patch that git applies, including a missing final newline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-diff-"));
    const before = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"); // no final newline
    const after = before.replace("line 1", "LINE 1").replace("line 11", "LINE 11");
    await writeFile(path.join(dir, "f.txt"), before);
    const diff = unifiedDiff("f.txt", before, after);
    expect(diff).toContain("\\ No newline at end of file");
    await writeFile(path.join(dir, "p.diff"), diff + "\n");
    await run("git", ["init", "-q"], { cwd: dir });
    await run("git", ["apply", "p.diff"], { cwd: dir });
    expect(await readFile(path.join(dir, "f.txt"), "utf8")).toBe(after);
  });
});

describe("CLI --fix / --dry-run", () => {
  const PAGE = `<!doctype html>\n<html lang="en_GB">\n<head><title>x</title><meta name="viewport" content="width=device-width, maximum-scale=1"></head>\n<body><span aria-lable="Close">x</span></body>\n</html>\n`;

  it("--dry-run prints the diff and writes nothing", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-fix-"));
    await writeFile(path.join(dir, "index.html"), PAGE);
    const r = await cli(dir, "scan", ".", "--dry-run");
    expect(r.stdout).toMatch(/^--- a\/index\.html\n\+\+\+ b\/index\.html\n@@ -1,5 \+1,5 @@/);
    expect(r.stdout).toContain('+<html lang="en-GB">');
    expect(r.stderr).toMatch(/dry run: 3 findings fixable in 1 file; nothing written/);
    expect(r.code).toBe(1); // findings remain
    expect(await readFile(path.join(dir, "index.html"), "utf8")).toBe(PAGE);
  });

  it("--fix shows the diff, writes, and reports what is left", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "wcag-fix-"));
    await writeFile(path.join(dir, "index.html"), PAGE);
    const r = await cli(dir, "scan", ".", "--fix", "--json");
    expect(r.stderr).toContain("--- a/index.html"); // stdout carries the JSON report
    expect(r.stderr).toMatch(/fixed 3 findings in 1 file/);
    expect(JSON.parse(r.stdout).summary.total).toBe(0);
    expect(r.code).toBe(0);
    expect(await readFile(path.join(dir, "index.html"), "utf8")).toContain('<html lang="en-GB">');
  });
});
