# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). While the major version is 0, minor releases may
change rule behavior or output fields; the JSON finding format is kept backward compatible
within a minor line.

## [Unreleased]

### Added

- **CSS analysis** (`focus-outline-removed`, WCAG 2.4.7): the static scan now reads `.css`, `.scss` and `.less`
  files and `<style>` blocks (HTML, Vue, Svelte, Astro), and reports `outline: none` / `outline: 0` on focus or
  focusable selectors when no focus style in the same stylesheet replaces it. It also reports Tailwind
  `outline-none` / `focus:outline-none` on focusable elements without a `focus:` / `focus-visible:` ring,
  outline, border or shadow class (or a `focus-within:` wrapper, `group-focus` / `peer-focus` indicator). Text
  fields, `tabindex="-1"`, composite widgets, components and the `:focus:not(:focus-visible)` pattern are skipped.
- **Five new static rules**, each mapped to WCAG 2.2 and documented in `references/RULES.md`:
  - `autocomplete-valid` (1.3.5): invalid `autocomplete` values, with the intended token for typos and
    common aliases (`emial` → `email`, `firstname` → `given-name`, `work name` → `name`).
  - `label-in-name` (2.5.3): `aria-label` that does not contain the control's visible text.
  - `table-headers` (1.3.1): data tables without `<th>` / `scope`, and header rows made of `<td>`.
  - `duplicate-id-ref` (1.3.1, 4.1.2): duplicate ids that a `<label for>` or `aria-*` reference points to.
  - `tailwind-contrast` (1.4.3, medium confidence): `text-*` on `bg-*` classes below 4.5:1 (3:1 for large
    text), when both colors are known from Tailwind's default palette (v3 and v4) or arbitrary hex values.
- **Baseline file**: `scan --write-baseline` records the current findings in `.wcag-audit/baseline.json`
  (or the `--baseline <file>` path); `scan --baseline <file>` then reports and fails only on findings that
  are not in it. Matching uses the stable finding ids. A `--json` report also works as a baseline. The JSON
  summary gains `baselined`, and the GitHub Action a `baseline` input.

### Fixed

- Suppression comments with a reason (`wcag-audit-ignore img-alt: tracking pixel`), the documented form, now
  suppress the finding. The colon and the words of the reason were read as rule ids, so nothing was suppressed.
- The static HTML scanner ends comments where browsers do (`--!>`, `<!-->`, `<!--->`), so markup
  after such a comment is no longer skipped, and a suppression comment ending in `--!>` no longer
  silences every rule on the next line.
- The keyboard audit passes selectors to the page as data (`page.evaluate(fn, selector)`) instead of
  splicing them into code strings.

## [0.1.2] - 2026-11-14

### Changed

- GitHub Action metadata for the GitHub Marketplace listing (author, shorter description).
- Published from CI with npm trusted publishing (OIDC); no npm token is stored.
- README badges consolidated into one row.

## [0.1.1] - 2026-11-14

### Changed

- The npm package is now **`@mintwork/wcag-audit-skill`**; run it with `npx @mintwork/wcag-audit-skill`. The unscoped
  `wcag-audit-skill` package is deprecated and points here.
- The repository moved to [github.com/mintwork/wcag-audit-skill](https://github.com/mintwork/wcag-audit-skill); old URLs
  redirect.
- Skill, plugin and editor-integration instructions use the new package name.
- The GitHub Action now runs `@mintwork/wcag-audit-skill` when you pin `version:`.

## [0.1.0] - 2026-11-14

First public release.

### Added

- **Agent skill** `skills/wcag-audit` ([Agent Skills spec](https://agentskills.io/specification)):
  a phased procedure (static scan, runtime scan, adversarial verification, minimal fixes,
  report) with references for rules, fix patterns, verification, reporting and a manual
  checklist, a JSON schema for `findings.json` and a validator script.
- **Install paths** for Claude Code (plugin marketplace in `.claude-plugin/`), any
  skills-compatible agent (`npx skills add`), Codex and other `AGENTS.md` agents, and Cursor rules.
- **Static scanner** for HTML, JSX/TSX, Vue, Svelte and Astro (including markup inside Astro
  `{expressions}`) with 24 rules mapped to WCAG 2.2 success criteria: image and SVG
  alternatives, form labels, button and link names, fake buttons (`<div onClick>`,
  `@click`, `on:click`, `(click)`), heading order, `lang`, `title`, positive `tabindex`,
  iframe titles, focusable content in `aria-hidden`, invalid ARIA roles and attributes with
  suggestions, viewport zoom, captions, distracting elements and autofocus.
- **Runtime scanner**: opens pages in a real Chromium (Playwright Chromium, Chrome or Edge,
  auto-detected) and runs axe-core WCAG A/AA rules (AAA and best-practice opt-in), plus
  Tab traversal for keyboard traps (2.1.2) and invisible focus (2.4.7, pixel-verified).
  Violations are re-run and dropped if they do not reproduce.
- **CLI** `wcag-audit-skill scan | verify | rules` with text, JSON and SARIF 2.1.0 output,
  `--fail-on`, `--min-confidence`, `--rules`, `--ignore`, `--level`, `--wait-for` and more.
  Stable finding fingerprints power `verify` (resolved / remaining / introduced).
- **Suppression comments**: `wcag-audit-ignore <rule>: <reason>`.
- **GitHub composite action** (`uses: mintwork/wcag-audit-skill@v0`) that runs the CLI
  from the tagged source and uploads SARIF to code scanning, plus an example workflow with
  static and runtime jobs.
- Colored terminal output honors `NO_COLOR` and `FORCE_COLOR`.
- `npm run demo:gif` regenerates the README demo from the bundled fixtures.

### Precision work before release

- Conservative by default: spread props, bound values and components that may render text
  are assumed to be handled; heuristic findings are `confidence: "medium"`.
- Icon components from common icon libraries are treated as non-text when computing names.
- Capture-phase handlers recognized; `onClickCapture` containers are not reported as fake buttons.
- Inputs whose bound `type` is a choice of text-like literals are checked.

[Unreleased]: https://github.com/mintwork/wcag-audit-skill/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/mintwork/wcag-audit-skill/releases/tag/v0.1.2
[0.1.1]: https://github.com/mintwork/wcag-audit-skill/releases/tag/v0.1.1
[0.1.0]: https://github.com/mintwork/wcag-audit-skill/releases/tag/v0.1.0
