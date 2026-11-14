---
name: wcag-audit
description: Audits web UIs for WCAG 2.2 accessibility (a11y) failures and fixes them. Runs a phased procedure (static source scan of HTML/JSX/TSX/Vue/Svelte/Astro, real-browser runtime scan with axe-core and keyboard checks, adversarial verification of every finding, minimal fixes with explanations, and a machine-readable report). Use when the user asks to audit, check, review or fix accessibility, a11y, WCAG, ADA, Section 508 or EN 301 549 compliance, screen reader or keyboard support, color contrast, alt text, labels or focus, or before shipping UI the agent generated.
license: MIT. LICENSE has complete terms
compatibility: Requires Node.js 22+ for the bundled CLI (npx @mintwork/wcag-audit-skill). The runtime phase needs a Chromium browser (Playwright Chromium, Chrome or Edge) and a reachable URL. Works without the CLI in degraded, manual mode.
metadata:
  version: "0.1.2"
  standard: "WCAG 2.2 AA"
---

# WCAG Audit

You are auditing a user interface for accessibility barriers and fixing them. Disabled
users cannot work around a missing label the way a sighted mouse user can: treat each
confirmed finding as a real bug that blocks a real person.

**Goal:** a list of *verified* findings, each tied to a WCAG 2.2 success criterion, with a
precise location, evidence and a minimal fix — and then the fixes, applied and re-verified.

## Principles

1. **Verified or it does not ship.** Every finding must survive Phase 3. A short list of
   true issues beats a long list the user learns to ignore.
2. **Native HTML first.** The best ARIA is no ARIA. Fix `<div onClick>` by making it a
   `<button>`, not by bolting on `role`, `tabindex` and key handlers.
3. **Minimal, behavior-preserving fixes.** Change the markup that fails; do not restyle,
   refactor or reformat surrounding code. Keep visual design unchanged unless the finding
   *is* visual (contrast, focus ring, target size).
4. **Never invent content.** Alt text, labels and link text must reflect what the UI
   actually means. If you cannot tell what an image conveys, mark the finding
   `needs_validation` and ask; do not write `alt="image"`.
5. **Automation is a floor, not a ceiling.** Tools catch roughly a third to half of WCAG
   failures. Report what was *not* tested (see [the manual checklist](references/MANUAL-CHECKLIST.md)).

## Setup

Decide the scope from the user's request: whole repo, a directory, specific components,
or a URL. Then check tooling:

```bash
npx --yes @mintwork/wcag-audit-skill --version        # CLI available?
```

If the CLI is unavailable (offline, no Node), continue in **manual mode**: apply the rule
list in [references/RULES.md](references/RULES.md) by reading the source yourself, and skip
Phase 2 unless the user's environment offers another browser tool.

Write all artifacts to `.wcag-audit/` at the repository root (create it; suggest adding it
to `.gitignore`). Never write anywhere else unless the user asks.

## Workflow

Run the phases in order. Tell the user which phase you are in. For small scopes (one
component) phases can be brief, but do not skip Phase 3.

### Phase 1 — Static scan (source)

```bash
npx @mintwork/wcag-audit-skill scan <path> --json -o .wcag-audit/static.json --fail-on none
```

Then read [references/STATIC-SCAN.md](references/STATIC-SCAN.md) and do the review the tool
cannot: custom components that wrap native elements, conditional rendering, design-system
props (`<Icon label=…>`), focus styles removed in CSS-in-JS or replaced in another stylesheet
(the CLI checks `.css` / `.scss` / `.less` and Tailwind classes one file at a time), color-only state, and
anything the scanner skipped because of spread props or dynamic values. Add those as
candidate findings with `"source": "static"` and `"confidence": "medium"`.

### Phase 2 — Runtime scan (real browser)

Only if a URL is available or the app can be started. Find the dev command
(`package.json` scripts, README), start it in the background, wait for it to respond, then:

```bash
npx @mintwork/wcag-audit-skill scan http://localhost:3000 --json -o .wcag-audit/runtime.json --fail-on none
# More pages / states:
npx @mintwork/wcag-audit-skill scan http://localhost:3000/login http://localhost:3000/cart --json -o .wcag-audit/runtime-2.json --fail-on none
```

Scan the pages that matter (home, primary flows, forms, modals open) — see
[references/RUNTIME-SCAN.md](references/RUNTIME-SCAN.md) for states to cover, SPA waits
and auth. Runtime findings catch what static analysis cannot: computed contrast, real
accessible names, focus order, keyboard traps, invisible focus.

### Phase 3 — Verification (remove false positives)

For **every** candidate, follow [references/VERIFICATION.md](references/VERIFICATION.md).
Try to *disprove* it: open the source at the reported line, trace props/slots/spreads to
where the value is set, check whether a parent supplies the label, check the rendered DOM
for runtime findings. Assign one verdict:

- `confirmed` — you traced it and it fails the criterion. Record how you know.
- `needs_validation` — plausible but you could not establish it (e.g. alt text quality,
  content you cannot see, a page you cannot reach). No fix is applied.
- `rejected` — disproved. Record why (this teaches the user which rules to tune).

Merge duplicates: the same root cause reported by static and runtime is **one** finding
with both locations.

### Phase 4 — Fix

Fix `confirmed` findings, highest severity first, using
[references/FIX-PATTERNS.md](references/FIX-PATTERNS.md). For each fix:

1. Make the smallest change that satisfies the criterion, in the framework's idiom
   (`htmlFor` in React, `:aria-label` in Vue, etc.).
2. Explain it in one or two sentences: *what was wrong, who it affected, what changed.*
3. Ask before fixes that change visible UI or copy (contrast colors, new visible labels,
   link text) unless the user already said to go ahead.

Then re-verify mechanically:

```bash
npx @mintwork/wcag-audit-skill verify .wcag-audit/static.json
npx @mintwork/wcag-audit-skill verify .wcag-audit/runtime.json   # dev server still running
```

`verify` exits non-zero if anything remains or a fix introduced a new finding. Iterate
until the confirmed findings are resolved or you have explained why one cannot be fixed
in code (e.g. needs captions content from the user). Run the project's own tests/lint.

### Phase 5 — Report

Write `.wcag-audit/findings.json` conforming to
[assets/report-schema.json](assets/report-schema.json) and validate it:

```bash
node <skill-dir>/scripts/validate-findings.mjs .wcag-audit/findings.json
```

Then write `.wcag-audit/REPORT.md` and give the user a short summary, following
[references/REPORTING.md](references/REPORTING.md): counts by severity and verdict, what
was fixed, what needs their input, what was not tested.

## Severity

| Severity | Meaning | Examples |
| --- | --- | --- |
| critical | Blocks a task entirely for some users | unlabeled form field, `<div onClick>` as the only way to submit, keyboard trap, zoom disabled |
| serious | Major difficulty or missing information | low contrast body text, missing page language, link with no name |
| moderate | Friction, confusing structure | skipped heading levels, redundant or vague link text in context |
| minor | Polish, best practice | vague alt text, autofocus |

Severity reflects user impact in *this* UI, not the rule's default: an unlabeled search
box in a footer is less severe than an unlabeled password field on the login page.

## Anti-patterns (do not)

- Do not add `aria-label` that duplicates or contradicts visible text (breaks WCAG 2.5.3).
- Do not add `role="button"` + `tabindex="0"` when `<button>` works.
- Do not "fix" a heading-order finding by changing visual size; change the level and keep the CSS.
- Do not set `alt=""` on informative images to silence the scanner.
- Do not suppress findings (`wcag-audit-ignore`) without a written reason next to the comment.
- Do not claim WCAG "compliance" — automated + agent review can show failures, not conformance.
- Do not modify generated, vendored or `node_modules` code; fix the source component.

## Files

- [references/RULES.md](references/RULES.md) — every static and runtime rule, mapped to WCAG
- [references/STATIC-SCAN.md](references/STATIC-SCAN.md) — Phase 1 manual review by framework
- [references/RUNTIME-SCAN.md](references/RUNTIME-SCAN.md) — Phase 2 pages, states, SPAs, auth
- [references/VERIFICATION.md](references/VERIFICATION.md) — Phase 3 disproof procedure per rule
- [references/FIX-PATTERNS.md](references/FIX-PATTERNS.md) — Phase 4 before/after fixes
- [references/REPORTING.md](references/REPORTING.md) — Phase 5 report format
- [references/MANUAL-CHECKLIST.md](references/MANUAL-CHECKLIST.md) — what automation cannot check
- [assets/report-schema.json](assets/report-schema.json) — findings.json schema
- `scripts/validate-findings.mjs` — zero-dependency validator for findings.json
