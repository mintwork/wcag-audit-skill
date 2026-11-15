#!/usr/bin/env node
// Builds docs/demo.gif: runs the real CLI on the synthetic fixtures in test/fixtures/static,
// renders its ANSI output in a styled terminal page (typing + line reveal), captures frames
// with Playwright (Google Chrome), and encodes a GIF with ffmpeg palettegen/paletteuse.
//
//   npm run demo:gif                       # build, then write docs/demo.gif
//   FFMPEG=/path/to/ffmpeg npm run demo:gif
//   DEMO_KEEP_FRAMES=1 npm run demo:gif    # keep the PNG frames (path is printed)
//
// Only the bundled fixtures are scanned. Nothing outside this repository is shown.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist/cli.js");
const FIXTURES = path.join(ROOT, "test/fixtures/static");
const OUT = path.join(ROOT, process.env.DEMO_OUT ?? "docs/demo.gif");
const FFMPEG = process.env.FFMPEG ?? (existsSync("/opt/homebrew/bin/ffmpeg") ? "/opt/homebrew/bin/ffmpeg" : "ffmpeg");
const WIDTH = 1200;
const HEIGHT = 720;
const PROMPT = "~/shop $ ";

if (!existsSync(CLI)) {
  console.error("dist/cli.js not found. Run `npm run build` first (npm run demo:gif does this).");
  process.exit(2);
}

/** Run the real CLI with colors forced, from the fixtures directory so paths stay short. */
function cli(args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: FIXTURES,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "1", NO_COLOR: "" },
  });
  if (r.status === 2 || r.error) throw new Error(`CLI failed: ${r.stderr || r.error}`);
  return r.stdout.replace(/\n+$/, "").split("\n");
}

// ---------------------------------------------------------------- ANSI -> HTML
const FG = { 31: "red", 32: "green", 33: "yellow", 36: "cyan", 90: "gray" };
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ansiToHtml(line) {
  const indent = line.match(/^ */)[0].length;
  let state = { b: false, d: false, u: false, fg: null };
  let html = "";
  for (const part of line.slice(indent).split(/(\x1b\[[0-9;]*m)/)) {
    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      for (const code of (m[1] || "0").split(";").map(Number)) {
        if (code === 0) state = { b: false, d: false, u: false, fg: null };
        else if (code === 1) state.b = true;
        else if (code === 2) state.d = true;
        else if (code === 4) state.u = true;
        else if (FG[code]) state.fg = FG[code];
      }
      continue;
    }
    if (!part) continue;
    const cls = [state.b && "b", state.d && "d", state.u && "u", state.fg].filter(Boolean).join(" ");
    html += cls ? `<span class="${cls}">${esc(part)}</span>` : esc(part);
  }
  // Hanging indent: wrapped continuation lines align with the start of the text.
  return `<div class="l" style="padding-left:${indent}ch">${html || "&nbsp;"}</div>`;
}

// ---------------------------------------------------------------- timeline
// Each frame: { lines: html[], typing: string|null, cursor: bool, caption, ms }
const frames = [];
let lines = [];
let caption = "";
const push = (ms, extra = {}) => frames.push({ lines: [...lines], typing: null, cursor: false, caption, ms, ...extra });

function blink(ms) {
  const n = Math.max(1, Math.round(ms / 500));
  for (let i = 0; i < n; i++) push(500, { typing: "", cursor: i % 2 === 0 });
}

function type(cmd) {
  blink(500);
  for (let i = 1; i <= cmd.length; i++) push(i === cmd.length ? 300 : 32, { typing: cmd.slice(0, i), cursor: true });
  lines.push(`<div class="l"><span class="prompt">${esc(PROMPT)}</span>${esc(cmd)}</div>`);
  push(250);
}

/** Reveal output one block (finding) per frame; blocks are separated by blank lines. */
function revealBlocks(out, perBlock = 700) {
  let block = [];
  const flush = () => {
    if (!block.length) return;
    lines.push(...block.map(ansiToHtml));
    push(perBlock);
    block = [];
  };
  for (const raw of out) {
    block.push(raw);
    if (raw.trim() === "") flush();
  }
  flush();
}

/** Fast scroll: several lines per frame. */
function revealFast(out, { chunk = 5, ms = 40 } = {}) {
  for (let i = 0; i < out.length; i += chunk) {
    lines.push(...out.slice(i, i + chunk).map(ansiToHtml));
    push(ms);
  }
}

// Scene 1: a single React component, each finding with WCAG criterion and fix.
caption = "1/3 · scan a React component";
const cmd1 = "npx @mintwork/wcag-audit-skill scan bad/ProductCard.tsx";
const out1 = cli(["scan", "bad/ProductCard.tsx"]);
type(cmd1);
const summary1 = out1.length - 2;
revealBlocks(out1.slice(0, summary1), 750);
revealBlocks(out1.slice(summary1), 1800);

// Scene 2: a whole folder of HTML, React, Vue and Svelte.
caption = "2/3 · HTML, React, Vue, Svelte in one pass";
lines.push(ansiToHtml(""));
type("npx @mintwork/wcag-audit-skill scan bad/");
const out2 = cli(["scan", "bad/"]);
revealFast(out2.slice(0, -2), { chunk: 14, ms: 60 });
revealBlocks(out2.slice(-2), 2200);

// Scene 3: after the fixes, the same component is clean.
caption = "3/3 · after the agent's fixes";
lines.push(ansiToHtml(""));
const cmd3 = "npx @mintwork/wcag-audit-skill scan good/ProductCard.tsx";
type(cmd3);
const out3 = cli(["scan", "good/ProductCard.tsx"]);
revealBlocks(out3, 400);
push(3200, { typing: "", cursor: true });

// ---------------------------------------------------------------- page
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  body { background: linear-gradient(135deg, #1e3a8a 0%, #312e81 55%, #4c1d95 100%);
    font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; }
  .win { position: absolute; inset: 22px 28px 26px 28px; background: #0d1117; border-radius: 12px;
    box-shadow: 0 24px 60px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.08); overflow: hidden;
    display: flex; flex-direction: column; }
  .bar { height: 38px; flex: none; display: flex; align-items: center; padding: 0 16px; gap: 8px;
    background: #161b22; border-bottom: 1px solid #21262d; }
  .dot { width: 12px; height: 12px; border-radius: 50%; }
  .title { flex: 1; text-align: center; color: #8b949e; font-size: 13px; margin-right: 60px; }
  .cap { color: #c9d1d9; font-size: 12.5px; background: #1f6feb33; border: 1px solid #1f6feb88;
    padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .term { flex: 1; overflow: hidden; padding: 14px 20px 16px; font: 14.5px/1.5 "SF Mono", Menlo, Monaco, Consolas, monospace;
    color: #e6edf3; -webkit-font-smoothing: antialiased; }
  .l { white-space: pre-wrap; word-break: break-word; }
  .b { font-weight: 700; } .d { color: #8b949e; } .u { text-decoration: underline; text-underline-offset: 2px; color: #79c0ff; }
  .red { color: #ff7b72; } .green { color: #56d364; } .yellow { color: #e3b341; } .cyan { color: #76e3ea; } .gray { color: #8b949e; }
  .prompt { color: #56d364; font-weight: 700; }
  .cursor { display: inline-block; width: .6em; height: 1.15em; vertical-align: -0.2em; background: #e6edf3; }
</style></head><body>
  <div class="win" role="img" aria-label="Terminal running wcag-audit-skill">
    <div class="bar">
      <span class="dot" style="background:#ff5f57"></span><span class="dot" style="background:#febc2e"></span><span class="dot" style="background:#28c840"></span>
      <span class="title">wcag-audit-skill</span><span class="cap" id="cap"></span>
    </div>
    <div class="term" id="term"></div>
  </div>
  <script>
    window.render = (f) => {
      const typing = f.typing === null ? "" :
        '<div class="l"><span class="prompt">${esc(PROMPT)}</span>' +
        f.typing.replace(/&/g, "&amp;").replace(/</g, "&lt;") + (f.cursor ? '<span class="cursor"></span>' : "") + "</div>";
      const term = document.getElementById("term");
      term.innerHTML = f.lines.join("") + typing;
      term.scrollTop = term.scrollHeight; // top-aligned until full, then follows the output like a real terminal
      document.getElementById("cap").textContent = f.caption;
    };
  </script>
</body></html>`;

// ---------------------------------------------------------------- capture
const { chromium } = await import("playwright-core");
let browser;
for (const opts of [{ channel: "chrome" }, {}, { channel: "msedge" }]) {
  try {
    browser = await chromium.launch(opts);
    break;
  } catch {}
}
if (!browser) throw new Error("No browser found: install Google Chrome or run `npx playwright-core install chromium`.");

const dir = mkdtempSync(path.join(os.tmpdir(), "wcag-demo-"));
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
await page.setContent(PAGE);
await page.evaluate(() => document.fonts.ready);

let concat = "ffconcat version 1.0\n";
let total = 0;
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const file = `f${String(i).padStart(4, "0")}.png`;
  await page.evaluate((frame) => window.render(frame), f);
  await page.screenshot({ path: path.join(dir, file) });
  concat += `file '${file}'\nduration ${(f.ms / 1000).toFixed(3)}\n`;
  total += f.ms;
}
// The concat demuxer ignores the last duration unless the file is repeated.
concat += `file 'f${String(frames.length - 1).padStart(4, "0")}.png'\n`;
writeFileSync(path.join(dir, "frames.txt"), concat);
await browser.close();

// ---------------------------------------------------------------- encode
const filter = "[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full:reserve_transparent=0[p];[b][p]paletteuse=dither=none:diff_mode=rectangle";
execFileSync(
  FFMPEG,
  ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "frames.txt"), "-filter_complex", filter, "-fps_mode", "vfr", "-loop", "0", OUT],
  { stdio: "inherit" },
);

const mb = statSync(OUT).size / 1024 / 1024;
console.log(`${path.relative(ROOT, OUT)}: ${frames.length} frames, ${(total / 1000).toFixed(1)} s, ${WIDTH}x${HEIGHT}, ${mb.toFixed(2)} MB`);
if (process.env.DEMO_KEEP_FRAMES) console.log(`frames kept in ${dir}`);
else rmSync(dir, { recursive: true, force: true });
if (mb > 5) {
  console.error("demo.gif is over 5 MB; shorten the timeline or reduce the size.");
  process.exit(1);
}
