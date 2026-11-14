# Phase 2 — Runtime scan

Static analysis sees source; users meet the rendered DOM. Runtime scanning finds computed
contrast, real accessible names after components render, focus order, keyboard traps and
invisible focus.

## 1. Get a URL

- If the user gave a URL (staging, preview deploy), use it.
- Otherwise start the app: look at `package.json` scripts (`dev`, `start`, `preview`),
  README, `docker-compose.yml`. Start it **in the background**, wait until it responds
  (`curl -sf http://localhost:3000 >/dev/null`), and stop it when done.
- Static sites: `npx @mintwork/wcag-audit-skill scan ./dist/index.html --runtime` opens the file in
  the browser directly.
- Never scan production systems that the user did not name, and never submit real forms
  (orders, emails, payments) during an audit.

## 2. Scan

```bash
npx @mintwork/wcag-audit-skill scan http://localhost:3000 http://localhost:3000/signup \
  --json -o .wcag-audit/runtime.json --fail-on none
```

| Flag | Use |
| --- | --- |
| `--wait-for "main"` | SPA: wait until the app has rendered |
| `--level AAA` | include AAA criteria (only if the user targets AAA) |
| `--best-practice` | add axe best-practice rules (landmarks, `region`, `page-has-heading-one`) |
| `--no-keyboard` | skip Tab traversal on very large pages |
| `--browser chrome` | force local Chrome; set `WCAG_AUDIT_CHROME_PATH` for a custom binary |
| `--headed` | watch the browser |

If no browser launches: `npx playwright install chromium` (or install Chrome).

If the project has Storybook, scan every story too: it covers component states that no route
shows (`npm run build-storybook` first, or a running `npm run storybook`):

```bash
npx @mintwork/wcag-audit-skill scan --storybook storybook-static --json -o .wcag-audit/storybook.json --fail-on none
npx @mintwork/wcag-audit-skill scan --storybook http://localhost:6006 --stories button,forms/   # a subset
```

Map story findings to source through the story's `importPath` in `index.json`.

## 3. Cover states, not just pages

A page's initial load is a fraction of its UI. For each primary flow, also check:

- **Open overlays**: modal, drawer, menu, popover, tooltip, combobox listbox.
- **Form errors**: submit empty; are errors announced and associated?
- **Empty / loading / error states**: skeletons and spinners need a name or live status.
- **Responsive**: 320px wide (reflow, 1.4.10) and 200% zoom.
- **Dark mode / themes**: contrast is per theme.
- **Authenticated pages**: ask the user for a test account or a storage-state file;
  never guess credentials.

The CLI scans one state per URL. For other states, either add a route/query param that
renders them (e.g. Storybook stories: `http://localhost:6006/iframe.html?id=modal--open`)
or drive the browser yourself (Playwright MCP / browser tool) and inspect with axe:

```js
// in a browser tool: inject axe and run on the current state
await page.addScriptTag({ path: require.resolve("axe-core") });
const { violations } = await page.evaluate(() => axe.run());
```

## 4. Keyboard pass (manual, 2 minutes per flow)

The CLI's Tab traversal detects traps and invisible focus. Also check by driving the
browser: Tab order follows visual order (2.4.3); every action is reachable and operable
with Enter/Space/arrows (2.1.1); focus moves into a modal on open and back to the trigger
on close; a skip link exists on pages with repeated navigation (2.4.1); focus is never
hidden under a sticky header (2.4.11).

## 5. Map runtime findings back to source

Each runtime finding has a CSS selector and the rendered HTML. Find the source by
searching for distinctive class names, text, `data-testid`, or the component that renders
that route. Record the source file and line on the finding — the fix happens in source.
