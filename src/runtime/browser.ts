import type { Browser } from "playwright-core";

export interface LaunchOptions {
  /** Browser channel: "chromium" (Playwright-managed), "chrome", "msedge". */
  channel?: string;
  executablePath?: string;
  headed?: boolean;
}

/**
 * Launch Chromium. Tries, in order: an explicit executable / channel, the
 * Playwright-managed Chromium, then locally installed Chrome and Edge. This
 * means `npx @mintwork/wcag-audit-skill scan https://…` works on most dev machines
 * without a separate `playwright install` step.
 */
export async function launchBrowser(opts: LaunchOptions = {}): Promise<Browser> {
  const { chromium } = await import("playwright-core");
  const headless = !opts.headed;
  const executablePath = opts.executablePath ?? process.env.WCAG_AUDIT_CHROME_PATH;
  const attempts: Array<{ label: string; run: () => Promise<Browser> }> = [];
  if (executablePath) attempts.push({ label: executablePath, run: () => chromium.launch({ headless, executablePath }) });
  if (opts.channel && opts.channel !== "chromium") {
    attempts.push({ label: opts.channel, run: () => chromium.launch({ headless, channel: opts.channel }) });
  } else {
    attempts.push({ label: "playwright chromium", run: () => chromium.launch({ headless }) });
    if (!opts.channel) {
      attempts.push({ label: "chrome", run: () => chromium.launch({ headless, channel: "chrome" }) });
      attempts.push({ label: "msedge", run: () => chromium.launch({ headless, channel: "msedge" }) });
    }
  }
  const errors: string[] = [];
  for (const a of attempts) {
    try {
      return await a.run();
    } catch (err) {
      errors.push(`${a.label}: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  throw new Error(
    "Could not launch a Chromium browser for the runtime scan.\n" +
      "Fix: run `npx playwright install chromium`, install Google Chrome, or set WCAG_AUDIT_CHROME_PATH.\n" +
      errors.map((e) => "  - " + e).join("\n"),
  );
}
