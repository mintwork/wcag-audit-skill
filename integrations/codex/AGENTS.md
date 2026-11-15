<!-- Paste this section into the AGENTS.md at the root of your repository (Codex, Jules, Amp, Aider and other agents that read AGENTS.md). -->

## Accessibility (WCAG 2.2 AA)

All UI changes must be accessible. When you create or modify UI code (HTML, JSX/TSX, Vue,
Svelte, Astro) or the user asks for an accessibility / a11y / WCAG audit:

1. **Static scan** — `npx @mintwork/wcag-audit-skill scan <changed paths> --json --fail-on none`.
   Also review what the scanner cannot see: shared components (`Button`, `IconButton`,
   `Input`, `Modal`), `outline: none` without a `:focus-visible` replacement, color-only state.
2. **Runtime scan** — if the app runs locally, start it and run
   `npx @mintwork/wcag-audit-skill scan http://localhost:<port>/<page> --source src --json --fail-on none`
   (`--config <file>` for states such as an open modal or dark mode, `--storage-state <file>` for
   logged-in pages, `--storybook <url|dir>` for every story).
3. **Verify** — before fixing, open each finding's file:line and try to disprove it (trace
   props, spreads and parent components). Drop false positives; ask about anything you
   cannot establish (e.g. what an image conveys). Never invent alt text.
4. **Fix** — smallest change, native HTML first: `<button>` not `<div onClick>`, `<label for>`
   not placeholder, `alt=""` only for decorative images, `aria-label` on icon-only buttons with
   `aria-hidden="true"` on the icon. Do not change visual design (colors, copy) without asking.
   Explain each fix in one sentence: what was wrong, who it affected, what changed.
   Mechanical fixes (`html-lang`, `meta-viewport-zoom`, `aria-*` typos): `scan <path> --dry-run`,
   show the diff, then `--fix`.
5. **Re-check** — `npx @mintwork/wcag-audit-skill scan … --json -o /tmp/a11y.json` before fixing, then
   `npx @mintwork/wcag-audit-skill verify /tmp/a11y.json` after. It exits non-zero if anything remains
   or a fix introduced a new issue.
6. **Report** — counts by severity, what you fixed, what needs the user's input, and what
   automation cannot check (screen-reader pass, zoom/reflow, captions accuracy).

Never claim the UI is "WCAG compliant"; say which automated and manual checks passed.
