import type { Page } from "playwright-core";
import { fingerprint } from "../static/analyze.js";
import { truncate } from "../static/ast.js";
import type { Finding } from "../types.js";
import { levelFor, understandingUrl } from "../wcag.js";

interface Stop {
  selector: string;
  html: string;
  style: string;
  inModal: boolean;
}

/** Installed in the page: describe the active element and snapshot its focus-relevant styles. */
const PAGE_HELPERS = `
window.__wcagAudit = {
  selectorFor(el) {
    if (!(el instanceof Element)) return "";
    if (el.id && document.querySelectorAll("#" + CSS.escape(el.id)).length === 1) return "#" + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id && document.querySelectorAll("#" + CSS.escape(cur.id)).length === 1) { parts.unshift("#" + CSS.escape(cur.id)); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName);
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(cur) + 1) + ")";
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(" > ");
  },
  styleOf(el) {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0 ? "none" : s.outlineStyle + " " + s.outlineWidth + " " + s.outlineColor;
    return [outline, s.boxShadow, s.borderTopColor, s.borderBottomColor, s.borderTopWidth, s.borderBottomWidth, s.backgroundColor, s.color, s.textDecorationLine, s.transform, s.opacity].join("|");
  },
  focusables() {
    const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), summary, iframe, [contenteditable="true"]';
    return Array.from(document.querySelectorAll(sel)).filter(el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && !el.closest("[inert]");
    }).length;
  },
  stop() {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    return {
      selector: this.selectorFor(el),
      html: el.outerHTML.slice(0, 300),
      style: this.styleOf(el),
      inModal: !!el.closest('[aria-modal="true"], dialog[open]'),
    };
  },
  // The helpers below take a selector as a data argument (page.evaluate(fn, selector)); selectors are
  // never spliced into code strings.
  styleAt(sel) {
    const el = document.querySelector(sel);
    return el ? this.styleOf(el) : null;
  },
  refocusedStyleAt(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.focus({ focusVisible: true });
    const s = this.styleOf(el);
    el.blur();
    return s;
  },
  focus(sel) {
    document.querySelector(sel)?.focus();
  },
  focusVisible(sel) {
    const el = document.querySelector(sel);
    el?.focus({ focusVisible: true });
    return !!el && document.activeElement === el;
  },
  isActive(sel) {
    return document.activeElement === document.querySelector(sel);
  },
  blur(sel) {
    document.querySelector(sel)?.blur();
  },
  /** The element (or, if it has no box, e.g. a visually hidden radio, its nearest boxed ancestor) plus a margin for rings. */
  clipAround(sel) {
    let el = document.querySelector(sel);
    if (!el) return null;
    let r = el.getBoundingClientRect();
    while ((r.width < 4 || r.height < 4) && el.parentElement) { el = el.parentElement; r = el.getBoundingClientRect(); }
    const pad = 16, vw = innerWidth, vh = innerHeight;
    const x = Math.max(0, r.left - pad), y = Math.max(0, r.top - pad);
    const w = Math.min(vw, r.right + pad) - x, h = Math.min(vh, r.bottom + pad) - y;
    return w >= 2 && h >= 2 ? { x, y, width: w, height: h } : null;
  },
};
`;

interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Type of the helpers installed by PAGE_HELPERS, for functions passed to page.evaluate (which run in the page). */
interface PageWindow {
  __wcagAudit: {
    styleAt(sel: string): string | null;
    refocusedStyleAt(sel: string): string | null;
    focus(sel: string): void;
    focusVisible(sel: string): boolean;
    isActive(sel: string): boolean;
    blur(sel: string): void;
    clipAround(sel: string): Clip | null;
  };
}

export interface KeyboardOptions {
  maxTabs?: number;
  /** Don't click the page to reset focus (it could close an open modal or menu). */
  noMouse?: boolean;
}

/**
 * Tab through the page like a keyboard user and detect:
 *  - keyboard traps (WCAG 2.1.2): focus cycles inside a subset of controls and never escapes
 *  - invisible focus (WCAG 2.4.7): focusing an element changes none of its focus-related styles
 */
export async function keyboardAudit(page: Page, url: string, opts: KeyboardOptions = {}): Promise<Finding[]> {
  await page.evaluate(PAGE_HELPERS);
  const total = (await page.evaluate("window.__wcagAudit.focusables()")) as number;
  if (total === 0) return [];
  const maxTabs = opts.maxTabs ?? Math.min(250, total * 2 + 6);

  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  if (!opts.noMouse) await page.mouse.click(1, 1).catch(() => {});
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");

  const seq: Array<Stop | null> = [];
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press("Tab");
    seq.push((await page.evaluate("window.__wcagAudit.stop()")) as Stop | null);
  }

  const findings: Finding[] = [];

  // --- Keyboard trap: the tail of the sequence repeats a short cycle without ever reaching <body>.
  const tail = seq.slice(Math.floor(seq.length / 2));
  const escaped = tail.some((s) => s === null);
  const distinctAll = new Set(seq.filter(Boolean).map((s) => s!.selector));
  const distinctTail = new Set(tail.filter(Boolean).map((s) => s!.selector));
  // The tail is longer than one full Tab cycle. On a healthy page it either passes through <body>
  // or revisits every element seen so far; a trap keeps cycling through a strict subset.
  const stuck = distinctTail.size < distinctAll.size || (distinctTail.size === 1 && total > 1);
  if (!escaped && stuck) {
    const trapped = tail.filter(Boolean) as Stop[];
    if (!trapped.every((s) => s.inModal)) {
      // Verification: try the usual escape hatches and see whether focus is still stuck.
      await page.keyboard.press("Escape");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Tab");
      const after = (await page.evaluate("window.__wcagAudit.stop()")) as Stop | null;
      const stillTrapped = after !== null && distinctTail.has(after.selector);
      if (stillTrapped) {
        const first = trapped[0]!;
        findings.push(
          make("keyboard-trap", url, first, {
            title: "Keyboard focus must not be trapped",
            wcag: ["2.1.2"],
            severity: "critical",
            message: `Tab focus cycles between ${distinctTail.size} element(s) (${[...distinctTail].slice(0, 3).join(", ")}) and never reaches the rest of the page.`,
            fix: "Remove the keydown/blur handler that re-focuses this element, or (for intentional modal dialogs) mark the container role=\"dialog\" aria-modal=\"true\" and close it on Escape.",
          }),
        );
      }
    }
  }

  // --- Focus visible: compare each focused element's style with its unfocused style.
  const candidates: Stop[] = [];
  const unique = new Map<string, Stop>();
  for (const s of seq) if (s && !unique.has(s.selector)) unique.set(s.selector, s);
  await page.evaluate("document.activeElement && document.activeElement.blur && document.activeElement.blur()");
  for (const stop of unique.values()) {
    const blurred = await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.styleAt(sel), stop.selector);
    if (blurred === null || blurred !== stop.style) continue;
    // Verification: focus it again via keyboard-like focus and re-measure once.
    const refocused = await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.refocusedStyleAt(sel), stop.selector);
    if (refocused !== null && refocused !== blurred) continue;
    candidates.push(stop);
  }

  // Verification: the style snapshot misses indicators drawn on ::before/::after, on a child
  // (a card whose inner link gets the ring) or on a sibling (Tailwind peer-focus-visible), and
  // skip links that move on screen. Compare pixels around the element, focused vs blurred.
  const order = [...unique.keys()];
  for (const [i, stop] of candidates.entries()) {
    const visual = i < MAX_PIXEL_CHECKS ? await focusChangesPixels(page, stop.selector, order[order.indexOf(stop.selector) - 1]) : "unknown";
    if (visual === "changed") continue;
    findings.push(
      make("focus-visible", url, stop, {
        title: "Keyboard focus must be visible",
        wcag: ["2.4.7"],
        severity: "serious",
        message:
          visual === "unchanged"
            ? "Focusing this element changes nothing on screen (no outline, shadow, border, color or background on it or around it), so keyboard users cannot see where they are."
            : "Focusing this element changes none of its outline, shadow, border, color or background; a pixel check was not possible (animated area or off-screen), so confirm visually.",
        fix: "Do not remove outlines without a replacement. Add e.g. `:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }`.",
        confidence: visual === "unchanged" ? "medium" : "low",
      }),
    );
  }
  return findings;
}

/** Pixel checks are ~0.5 s each; beyond this many candidates, findings are reported unverified (low confidence). */
const MAX_PIXEL_CHECKS = 60;
const SETTLE_MS = 200;

/**
 * Focus the element the way a keyboard user would (Tab from the previous stop), screenshot the area
 * around it, blur, screenshot again. "changed" means some visible focus indicator exists.
 */
async function focusChangesPixels(page: Page, selector: string, prevSelector?: string): Promise<"changed" | "unchanged" | "unknown"> {
  try {
    let focused = false;
    if (prevSelector) {
      await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.focus(sel), prevSelector);
      await page.keyboard.press("Tab");
      focused = await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.isActive(sel), selector);
    }
    if (!focused) {
      focused = await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.focusVisible(sel), selector);
    }
    if (!focused) return "unknown";
    await page.waitForTimeout(SETTLE_MS);
    const clip = await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.clipAround(sel), selector);
    if (!clip) return "unknown";
    const focusedShot = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    await page.evaluate((sel) => (globalThis as unknown as PageWindow).__wcagAudit.blur(sel), selector);
    await page.waitForTimeout(SETTLE_MS);
    const blurredShot = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
    if (!focusedShot.equals(blurredShot)) {
      // Make sure the difference is focus, not an animation or video playing in that area.
      await page.waitForTimeout(SETTLE_MS);
      const again = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
      return again.equals(blurredShot) ? "changed" : "unknown";
    }
    return "unchanged";
  } catch {
    return "unknown";
  }
}

function make(
  ruleId: string,
  url: string,
  stop: Stop,
  f: { title: string; wcag: string[]; severity: Finding["severity"]; message: string; fix: string; confidence?: Finding["confidence"] },
): Finding {
  return {
    id: fingerprint(ruleId, url, stop.selector),
    ruleId,
    source: "keyboard",
    title: f.title,
    wcag: f.wcag,
    level: levelFor(f.wcag),
    severity: f.severity,
    confidence: f.confidence ?? "high",
    location: { url, selector: stop.selector },
    evidence: truncate(stop.html),
    message: f.message,
    fix: f.fix,
    helpUrl: understandingUrl(f.wcag[0]!),
    verified: true,
  };
}
