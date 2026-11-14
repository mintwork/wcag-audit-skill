/**
 * Storybook: scan every story. Reads the story index (`index.json`, Storybook 7+; `stories.json`, 6.x),
 * opens each story's iframe (`iframe.html?id=…&viewMode=story`) in one browser and runs the runtime scan
 * on it. Works with a running Storybook (URL) or a static build directory (served on a local port).
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fingerprint } from "../static/analyze.js";
import type { ScanResult } from "../types.js";
import { launchBrowser } from "./browser.js";
import { type RuntimeOptions, scanUrl } from "./scan-url.js";

export interface Story {
  id: string;
  title: string;
  name: string;
}

/** Storybook's own UI inside iframe.html (error / loading overlays, docs container): not the story. */
const STORYBOOK_CHROME = [".sb-wrapper", ".sb-errordisplay", ".sb-nopreview", ".sb-preparing-story", ".sb-preparing-docs", "#storybook-docs", "#docs-root"];

interface IndexEntry {
  id?: string;
  title?: string;
  kind?: string;
  name?: string;
  story?: string;
  type?: string;
}

/** Stories from an index.json (v4/v5 `entries`) or stories.json (v3 `stories`). Docs entries are skipped. */
export function storiesFromIndex(data: unknown): Story[] {
  const d = data as { entries?: Record<string, IndexEntry>; stories?: Record<string, IndexEntry> };
  const entries = d?.entries ?? d?.stories;
  if (!entries || typeof entries !== "object") throw new Error("not a Storybook index (no entries / stories)");
  const out: Story[] = [];
  for (const [key, e] of Object.entries(entries)) {
    if (e.type && e.type !== "story") continue; // "docs" pages
    out.push({ id: e.id ?? key, title: e.title ?? e.kind ?? "", name: e.name ?? e.story ?? "" });
  }
  return out;
}

/** Comma-separated, case-insensitive substrings matched against the story id and "Title / Name". */
export function filterStories(stories: Story[], patterns?: string): Story[] {
  const ps = (patterns ?? "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!ps.length) return stories;
  return stories.filter((s) => ps.some((p) => s.id.toLowerCase().includes(p) || `${s.title} / ${s.name}`.toLowerCase().includes(p)));
}

async function fetchJson(url: string): Promise<{ status: number; data?: unknown }> {
  const res = await fetch(url);
  if (!res.ok) return { status: res.status };
  return { status: res.status, data: await res.json() };
}

/** Serve a static Storybook build on 127.0.0.1 (files inside `dir` only). */
async function serveDir(dir: string): Promise<{ base: string; close: () => Promise<void> }> {
  const root = path.resolve(dir);
  const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json" };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const file = path.join(root, pathname.endsWith("/") ? pathname + "index.html" : pathname);
      if (file !== root && !file.startsWith(root + path.sep)) return void res.writeHead(403).end();
      if (!(await stat(file)).isFile()) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      createReadStream(file).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise((r) => server.close(() => r())) };
}

export interface StorybookOptions extends RuntimeOptions {
  /** Comma-separated substrings of story ids / titles to scan. */
  stories?: string;
  /** Exact story ids to scan (used by verify). */
  storyIds?: string[];
  /** Called after each story (progress). */
  onStory?: (index: number, total: number, story: Story) => void;
}

/** Scan every story of a Storybook at `target` (http(s) URL or a static build directory). */
export async function scanStorybook(target: string, opts: StorybookOptions = {}): Promise<ScanResult[]> {
  const isUrl = /^https?:\/\//i.test(target);
  const served = isUrl ? undefined : await serveDir(target);
  const base = (served?.base ?? target).replace(/\/(index\.html|iframe\.html)?$/, "");
  try {
    let index = await fetchJson(`${base}/index.json`);
    if (!index.data) index = await fetchJson(`${base}/stories.json`);
    if (!index.data) throw new Error(`no Storybook index at ${isUrl ? base : target} (index.json / stories.json: HTTP ${index.status})`);
    let stories = filterStories(storiesFromIndex(index.data), opts.stories);
    if (opts.storyIds) stories = stories.filter((s) => opts.storyIds!.includes(s.id));
    if (!stories.length) throw new Error(opts.stories ? `no stories match "${opts.stories}"` : "the Storybook has no stories");
    const browser = opts.browser ?? (await launchBrowser(opts));
    const results: ScanResult[] = [];
    try {
      for (const [i, story] of stories.entries()) {
        const url = `${base}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
        const r = await scanUrl(url, {
          ...opts,
          browser,
          // Storybook 7+ renders into #storybook-root, 6.x into #root.
          waitFor: opts.waitFor ?? "#storybook-root > *, #root > *",
          waitForOptional: opts.waitFor === undefined,
          timeoutMs: opts.timeoutMs ?? 15_000,
          exclude: [...STORYBOOK_CHROME, ...(opts.exclude ?? [])],
        });
        // Ids and locations from the story id, not the URL: a static build is served on a random port.
        const where = isUrl ? url : `${target.replace(/\/$/, "")}/iframe.html?id=${encodeURIComponent(story.id)}&viewMode=story`;
        for (const f of r.findings) {
          f.id = fingerprint(f.ruleId, `storybook:${story.id}`, f.location.selector ?? "", f.evidence);
          f.location.url = where;
        }
        r.target = where;
        r.story = { ...story, source: target };
        results.push(r);
        opts.onStory?.(i + 1, stories.length, story);
      }
    } finally {
      if (!opts.browser) await browser.close();
    }
    return results;
  } finally {
    await served?.close();
  }
}
