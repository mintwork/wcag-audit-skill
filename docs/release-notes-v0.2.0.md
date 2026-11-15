# WCAG Accessibility Audit v0.2.0

**AI ships inaccessible UIs. This makes your agent fix them.**

wcag-audit-skill is an Agent Skill, a CLI and a GitHub Action that audits a UI against WCAG 2.2:
static source scan, real-browser scan, verification, fix, report. Every finding is tied to a
success criterion, carries evidence and a concrete fix, and is re-checked after the fix.

0.2.0 is about adopting it on real projects: fail CI only on new findings, cover more of your
stack (MDX, CSS, Angular, Storybook, design systems), scan the states and logged-in pages users
actually see, and fix the mechanical issues automatically.

## Highlights

- **Baseline mode: fail CI only on new findings.** Record today's findings once with
  `scan src --write-baseline`, commit `.wcag-audit/baseline.json`, and `--baseline` (or the
  Action's new `baseline` input) reports and fails only on findings that are not in it.
- **30 static rules (6 new).**
  - `autocomplete-valid` (1.3.5): invalid `autocomplete` values, with the intended token
    (`emial` → `email`, `firstname` → `given-name`).
  - `label-in-name` (2.5.3): an `aria-label` that doesn't contain the visible text.
  - `table-headers` (1.3.1): data tables without `<th>` / `scope`.
  - `duplicate-id-ref` (1.3.1, 4.1.2): duplicate ids that a label or ARIA reference points to.
  - `tailwind-contrast` (1.4.3): `text-*` on `bg-*` below 4.5:1, from Tailwind's default
    palette (v3 and v4) or arbitrary hex values.
  - `focus-outline-removed` (2.4.7): `outline: none` in `.css` / `.scss` / `.less`, `<style>`
    blocks and Tailwind classes, without a `:focus-visible` replacement.
- **MDX.** Docs pages are scanned: JSX blocks plus Markdown headings, links and images.
- **Labels resolved across files.** The scan follows imports (relative paths, tsconfig
  `paths`, workspace packages): thin `<Input {...props}>` wrappers, imported `<Field>`
  wrappers, and design-system inputs from MUI, antd, Mantine, Chakra, React Aria, HeroUI,
  React Bootstrap, Fluent UI and Headless UI.
- **`--fix` and `--dry-run`.** Mechanical findings (`html-lang`, `meta-viewport-zoom`, ARIA
  attribute typos) are fixed in place. A git-compatible diff is always shown first.
- **Multi-state and authenticated runtime scans.** A JSON config (`--config`) scans every page
  in its default state and in each state: open a modal, submit an empty form, dark mode,
  320px. `--storage-state` scans logged-in pages with a Playwright storage state.
- **Angular inline templates.** `template:` strings in `@Component` are scanned, at their
  real line in the `.ts` file.
- **Storybook.** `--storybook <url|dir>` scans every story from `index.json`, in one browser.
- **Source hints.** `--source src` points runtime findings at the file and line that probably
  render the element (test ids, ids, labels, class names, text), marked as a hint.
- **Security fixes.** The HTML parser ends comments the way browsers do (`--!>`), so markup after
  such a comment is no longer skipped. The keyboard audit passes selectors to the page as data,
  never as code.
- **Babel 8.** The JSX/TSX parser is `@babel/parser` 8.1.2. Results on real-world React, MDX
  and Angular projects are identical to 0.1.x.

## GitHub Action

```yaml
# .github/workflows/accessibility.yml
name: Accessibility
on: [pull_request]
permissions: { contents: read, security-events: write }
jobs:
  wcag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: mintwork/wcag-audit-skill@v0
        with:
          targets: src
          fail-on: serious
          baseline: .wcag-audit/baseline.json   # create it once: npx @mintwork/wcag-audit-skill scan src --write-baseline
```

Findings appear as PR annotations and under **Security → Code scanning**.

## Field-tested

All new rules and file types were hand-checked on 13 more open-source frontends (React/Next,
Svelte, Vue, Angular, Astro, MDX docs, plain HTML), using static scans only:

- New rules: 22 of 25 clear true positives, 0 false positives.
- Cross-file `form-label`: 39 of 40 sampled findings true.
- Angular templates: 30 of 35 true, 0 false positives.
- MDX: 0 false positives on 618 files.
- `--source` hints: always in the right file in an offline test.
- Scan speed is unchanged.

## Install / upgrade

- **CLI:** `npx @mintwork/wcag-audit-skill@0.2.0 scan ./src`
- **Claude Code:** `/plugin marketplace update wcag-audit-skill`, or
  `/plugin marketplace add mintwork/wcag-audit-skill` then `/plugin install wcag-audit@wcag-audit-skill`
- **Any skills-compatible agent:** `npx skills add https://github.com/mintwork/wcag-audit-skill --skill wcag-audit`
- **GitHub Action:** `uses: mintwork/wcag-audit-skill@v0` (or pin `@v0.2.0`)

The full list of changes is in the [CHANGELOG](https://github.com/mintwork/wcag-audit-skill/blob/main/CHANGELOG.md#020---2026-11-15).
