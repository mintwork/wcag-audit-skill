/**
 * Runtime states: a page is more than its initial load. A state is a fresh browser context (color
 * scheme, viewport, reduced motion) plus steps that bring the UI into shape (open a modal, submit an
 * empty form) before the scan. States come from a JSON config file (`--config`) or CLI flags.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";

export type StateStep =
  | { click: string }
  | { fill: string; value: string }
  | { press: string; selector?: string }
  | { hover: string }
  | { check: string }
  | { select: string; value: string }
  | { waitFor: string }
  | { wait: number };

export interface RuntimeState {
  /** Shown in reports and part of each finding id, so it must be unique per page. */
  name: string;
  steps?: StateStep[];
  colorScheme?: "light" | "dark";
  viewport?: { width: number; height: number };
  reducedMotion?: "reduce" | "no-preference";
}

export interface PageConfig {
  url: string;
  waitFor?: string;
  /** Extra states for this page, in addition to the config's global states. */
  states?: RuntimeState[];
}

export interface RuntimeConfig {
  baseUrl?: string;
  /** Playwright storage state (cookies, localStorage) for authenticated pages. Relative to the config file. */
  storageState?: string;
  waitFor?: string;
  /** States applied to every page (dark mode, 320px). */
  states?: RuntimeState[];
  pages: PageConfig[];
}

export interface ScanJob {
  url: string;
  waitFor?: string;
  state?: RuntimeState;
}

const STEP_KINDS = ["click", "fill", "press", "hover", "check", "select", "waitFor", "wait"];

function fail(file: string, msg: string): never {
  throw new Error(`${file}: ${msg}`);
}

function checkState(file: string, s: unknown, where: string): RuntimeState {
  if (!s || typeof s !== "object") fail(file, `${where} must be an object`);
  const st = s as Record<string, unknown>;
  if (typeof st.name !== "string" || !st.name.trim()) fail(file, `${where}.name must be a non-empty string`);
  if (st.colorScheme !== undefined && st.colorScheme !== "light" && st.colorScheme !== "dark") fail(file, `${where}.colorScheme must be "light" or "dark"`);
  if (st.reducedMotion !== undefined && st.reducedMotion !== "reduce" && st.reducedMotion !== "no-preference") fail(file, `${where}.reducedMotion must be "reduce" or "no-preference"`);
  if (st.viewport !== undefined) {
    const v = st.viewport as Record<string, unknown>;
    if (!v || typeof v.width !== "number" || typeof v.height !== "number" || v.width < 1 || v.height < 1) fail(file, `${where}.viewport must be { "width": number, "height": number }`);
  }
  if (st.steps !== undefined) {
    if (!Array.isArray(st.steps)) fail(file, `${where}.steps must be an array`);
    st.steps.forEach((step, i) => {
      const keys = step && typeof step === "object" ? Object.keys(step) : [];
      const kind = keys.find((k) => STEP_KINDS.includes(k));
      if (!kind) fail(file, `${where}.steps[${i}] must have one of: ${STEP_KINDS.join(", ")}`);
      const v = (step as Record<string, unknown>)[kind];
      if (kind === "wait" ? typeof v !== "number" : typeof v !== "string") fail(file, `${where}.steps[${i}].${kind} must be a ${kind === "wait" ? "number (ms)" : "string"}`);
      if ((kind === "fill" || kind === "select") && typeof (step as Record<string, unknown>).value !== "string") fail(file, `${where}.steps[${i}] needs a string "value"`);
    });
  }
  return st as unknown as RuntimeState;
}

/** Read and validate a config file. Relative page URLs resolve against baseUrl; storageState against the file. */
export async function loadRuntimeConfig(file: string): Promise<RuntimeConfig> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    fail(file, (e as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : `not valid JSON (${(e as Error).message})`);
  }
  const c = data as Record<string, unknown>;
  if (!c || typeof c !== "object") fail(file, "must be a JSON object");
  if (!Array.isArray(c.pages) || !c.pages.length) fail(file, '"pages" must be a non-empty array of URLs or { "url": … } objects');
  const baseUrl = typeof c.baseUrl === "string" ? c.baseUrl : undefined;
  const states = Array.isArray(c.states) ? c.states.map((s, i) => checkState(file, s, `states[${i}]`)) : undefined;
  if (c.states !== undefined && !Array.isArray(c.states)) fail(file, '"states" must be an array');
  const pages: PageConfig[] = c.pages.map((p, i) => {
    const page = typeof p === "string" ? { url: p } : (p as Record<string, unknown>);
    if (!page || typeof page.url !== "string") fail(file, `pages[${i}] must be a URL string or { "url": … }`);
    let url = page.url as string;
    if (!/^(https?|file):\/\//i.test(url)) {
      if (!baseUrl) fail(file, `pages[${i}].url "${url}" is relative, so "baseUrl" is required`);
      url = new URL(url, baseUrl).href;
    }
    return {
      url,
      waitFor: typeof page.waitFor === "string" ? page.waitFor : undefined,
      states: Array.isArray(page.states) ? page.states.map((s, j) => checkState(file, s, `pages[${i}].states[${j}]`)) : undefined,
    };
  });
  const storageState = typeof c.storageState === "string" ? path.resolve(path.dirname(file), c.storageState) : undefined;
  return { baseUrl, storageState, waitFor: typeof c.waitFor === "string" ? c.waitFor : undefined, states, pages };
}

/** Every page in its default state, then in each global and page state. State names must be unique per page. */
export function jobsFromConfig(config: RuntimeConfig): ScanJob[] {
  const jobs: ScanJob[] = [];
  for (const p of config.pages) {
    const waitFor = p.waitFor ?? config.waitFor;
    jobs.push({ url: p.url, waitFor });
    const names = new Set<string>();
    for (const state of [...(config.states ?? []), ...(p.states ?? [])]) {
      if (names.has(state.name)) throw new Error(`state "${state.name}" is defined twice for ${p.url}`);
      names.add(state.name);
      jobs.push({ url: p.url, waitFor, state });
    }
  }
  return jobs;
}

/** Run a state's steps. Each step waits for its element (up to `timeoutMs`). */
export async function runSteps(page: Page, steps: StateStep[], timeoutMs: number): Promise<void> {
  for (const [i, step] of steps.entries()) {
    const s = step as Record<string, unknown>;
    try {
      if ("click" in s) await page.click(s.click as string, { timeout: timeoutMs });
      else if ("fill" in s) await page.fill(s.fill as string, s.value as string, { timeout: timeoutMs });
      else if ("press" in s) {
        if (typeof s.selector === "string") await page.press(s.selector, s.press as string, { timeout: timeoutMs });
        else await page.keyboard.press(s.press as string);
      } else if ("hover" in s) await page.hover(s.hover as string, { timeout: timeoutMs });
      else if ("check" in s) await page.check(s.check as string, { timeout: timeoutMs });
      else if ("select" in s) await page.selectOption(s.select as string, s.value as string, { timeout: timeoutMs });
      else if ("waitFor" in s) await page.waitForSelector(s.waitFor as string, { timeout: timeoutMs });
      else if ("wait" in s) await page.waitForTimeout(Math.min(Number(s.wait), 30_000));
    } catch (e) {
      throw new Error(`step ${i + 1} (${JSON.stringify(step)}) failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  // Let animations and requests triggered by the steps settle.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(200);
}
