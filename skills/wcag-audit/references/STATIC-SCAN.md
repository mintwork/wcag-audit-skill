# Phase 1 — Static scan

The CLI handles the mechanical checks. Your job in this phase is the review it cannot do.

## 1. Run the scanner

```bash
npx @mintwork/wcag-audit-skill scan src --json -o .wcag-audit/static.json --fail-on none
npx @mintwork/wcag-audit-skill rules            # what it checks
```

Useful flags: `--ignore storybook,fixtures`, `--rules form-label,button-name`,
`--min-confidence high`. The scanner skips `node_modules`, build output, tests and stories.

Read the JSON, not just the summary. Group findings by component: ten `button-name`
findings in ten pages often trace back to **one** `IconButton` component.

## 2. Map the component layer

Most real-world a11y bugs live in shared components the scanner treats as opaque.

1. Find the design-system / UI folder (`components/ui`, `src/lib/components`, `packages/ui`).
2. For each primitive that renders an interactive element (`Button`, `IconButton`, `Link`,
   `Input`, `Select`, `Checkbox`, `Modal`, `Dialog`, `Tooltip`, `Menu`, `Tabs`, `Toast`):
   - Does it forward `aria-*` / `id` / `ref` to the DOM element?
   - Does an icon-only variant **require** a label prop (`label`, `aria-label`)?
   - Does the input primitive render a `<label>` or accept `id` so callers can?
   - Does the modal trap focus *while open*, restore focus on close, close on Escape,
     and set `role="dialog"` + `aria-modal="true"` + an accessible name?
3. Then grep call sites for misuse, e.g.:

```bash
rg -n "<IconButton(?![^>]*aria-label)(?![^>]*label=)" --pcre2 src
rg -n "outline:\s*(none|0)" --glob '*.{ts,tsx,js,jsx}' src   # CSS-in-JS; stylesheets are scanned
rg -n "onClick=" src | rg -v "<(button|a|input|select|summary|[A-Z])"
```

## 3. Things to look for by hand

| Pattern | WCAG | What to check |
| --- | --- | --- |
| `outline: none` in CSS-in-JS (styled-components, emotion), or in a stylesheet whose replacement lives in another file | 2.4.7 | The scanner checks `.css` / `.scss` / `.less`, `<style>` and Tailwind classes (`focus-outline-removed`), one stylesheet at a time. Is there a replacement `:focus-visible` style (`ring`, `box-shadow`, border)? |
| Color-only state (red border = error, green dot = online) | 1.4.1 | Is there text, an icon with a name, or `aria-invalid` + message? |
| Form errors | 3.3.1, 4.1.3 | Error text linked via `aria-describedby`; `aria-invalid="true"`; announced (`role="alert"` or live region) |
| Custom select / combobox / menu / tabs | 4.1.2, 2.1.1 | Matches the ARIA APG pattern: roles, `aria-expanded`, arrow keys, Escape |
| Toasts / async updates | 4.1.3 | Status messages in an `aria-live` region |
| `<img>` alt from data | 1.1.1 | Is the bound value ever empty/undefined for informative images? |
| Icon fonts / emoji as content | 1.1.1 | `aria-hidden="true"` on decorative icons; text alternative for meaningful ones |
| `hidden` vs visually hidden | 1.3.1 | `display:none` hides from AT; use an `sr-only` class for screen-reader-only text |
| Fixed headers / sticky bars | 2.4.11 | Can a focused element be fully covered? |
| Drag-and-drop | 2.5.7 | Single-pointer alternative exists |
| Target size | 2.5.8 | Icon buttons at least 24×24 CSS px (`h-6 w-6` minimum) |
| `lang` on mixed-language content | 3.1.2 | Quotes / names in another language have `lang` |
| Auto-playing media / carousels | 2.2.2 | Pause control; respects `prefers-reduced-motion` |
| Timeouts / session expiry | 2.2.1 | Warning and a way to extend |
| Login / CAPTCHA | 3.3.8 | Paste allowed into password fields; no cognitive puzzle without alternative |

## 4. Framework notes

- **React / Next.js**: `htmlFor`, `tabIndex`, `aria-*` stay kebab-case. `next/image`
  requires `alt`. `next/link` renders `<a>` — check its children for a name. Watch for
  `onClick` on `<div>` from copy-pasted UI kits.
- **Vue**: bound attributes (`:alt`, `:aria-label`) are dynamic — check the data can't be
  empty. `v-html` content is invisible to static analysis; scan it at runtime.
- **Svelte**: Svelte's compiler already emits `a11y-*` warnings — run `npx svelte-check`
  and treat its a11y warnings as candidates too.
- **Angular**: `[attr.aria-label]` for ARIA bindings; `(click)` on non-buttons is the most
  common failure. `@angular/cdk/a11y` provides `FocusTrap` and `LiveAnnouncer`.
- **Astro**: frontmatter is skipped; framework islands (`.tsx`, `.vue`, `.svelte`) are
  scanned by their own parsers.
- **Tailwind**: `sr-only` for hidden labels; `focus-visible:ring-2` as the focus style;
  check `text-gray-400` on white (fails 4.5:1).

Record each manual candidate with `source: "static"`, the file and line, and
`confidence: "medium"` until Phase 3 confirms it.
