# Rules

All rules map to WCAG 2.2 success criteria. Severity is the default; adjust it to the
user impact in context during verification (see SKILL.md, "Severity").

## Static rules (source code)

Run by `wcag-audit-skill scan <path>`. Parsers: HTML, JSX/TSX (Babel), Vue SFC templates,
Svelte, Astro, and stylesheets (`.css`, `.scss`, `.less`, `<style>` blocks) for focus outlines. Elements with spread props (`{...props}`, `v-bind="obj"`) and dynamic
values are treated as unknown and **not** reported, to keep false positives low — review
them manually in Phase 1.

| Rule | WCAG | Default severity | Checks |
| --- | --- | --- | --- |
| `img-alt` | 1.1.1 (A) | critical | `<img>` (and `next/image` `<Image>`) without `alt` / `aria-label` / `role="presentation"` |
| `img-alt-meaningful` | 1.1.1 (A) | minor | `alt` is a file name or a placeholder word ("image", "photo", "logo") |
| `input-image-alt` | 1.1.1, 4.1.2 (A) | critical | `<input type="image">` without `alt` |
| `svg-img-name` | 1.1.1 (A) | serious | `<svg role="img">` without `<title>` or `aria-label` |
| `form-label` | 1.3.1, 3.3.2, 4.1.2 (A) | critical | `input` / `select` / `textarea` with no `<label for>`, wrapping `<label>`, `aria-label`, `aria-labelledby` or `title` (placeholder is not a label). `<Label htmlFor>` / `<FormLabel htmlFor>` components count as `<label for>`. At medium confidence: controls inside a `<Field>`-style wrapper (defined in the same file **or imported from the project**) whose `<label>` neither wraps `{children}` nor has `htmlFor`; project components that only forward props to one `<input>` / `<select>` / `<textarea>` (`<Input {...props} />`, shadcn-style) used without a label; and design-system inputs without their label prop or wrapper: MUI `TextField` / `Input*` (`label`, `inputProps`, `slotProps`), Mantine `TextInput` & co. (`label`), antd `Input` / `Select` (`<Form.Item label>`), Chakra `Input` (`<Field.Root>` / `<FormControl>`), React Aria `TextField` (`<Label>`), HeroUI, React Bootstrap (`<Form.Group controlId>`), Fluent UI (`<Field>`), Headless UI (`<Field>`). Imports resolve through relative paths, tsconfig / jsconfig `paths` and workspace packages; npm packages are not read |
| `button-name` | 4.1.2 (A) | critical | `<button>` / `role="button"` with no text, no labelled image, no `aria-label`, not named by a wrapping `<label>`. Icons imported from icon libraries (lucide, `@mui/icons-material`, react-icons, heroicons, …) count as icons. At medium confidence: `<Button>` / `<IconButton>` components whose only children are icons and that get no `aria-label` / `title` / `label` prop |
| `link-name` | 2.4.4, 4.1.2 (A) | serious | `<a href>` with no text or labelled image |
| `link-text-vague` | 2.4.4 (A) | minor | link text is "click here", "read more", "here", … |
| `no-div-button` | 2.1.1, 4.1.2 (A) | critical | `div`/`span`/`li`/… with `onClick` / `@click` / `on:click` / `(click)` and no role |
| `interactive-role-keyboard` | 2.1.1 (A) | serious | element with an interactive role but no `tabindex`, or click handler without key handler |
| `anchor-is-button` | 2.1.1, 4.1.2 (A) | serious / critical | `<a onClick>` with no `href`, `href="#"` or `javascript:` |
| `heading-order` | 1.3.1 (A) | moderate | heading level jumps by more than one (h1 → h3) within a file (JSX: within one rendered tree, so separate components don't compare) |
| `empty-heading` | 1.3.1, 2.4.6 (A/AA) | serious | `<h1>`–`<h6>` with no content |
| `html-lang` | 3.1.1 (A) | serious | `<html>` without `lang`, or an invalid BCP 47 tag |
| `document-title` | 2.4.2 (A) | serious | full HTML document without a non-empty `<title>` |
| `no-positive-tabindex` | 2.4.3 (A) | serious | `tabindex` greater than 0 |
| `focus-outline-removed` | 2.4.7 (AA) | serious | **Stylesheets** (`.css`, `.scss`, `.less`, and `<style>` in HTML / Vue / Svelte / Astro): `outline: none` / `0` / `transparent`, `outline-style: none`, `outline-width: 0` or `@apply outline-none` on a `:focus` / `:focus-visible` selector or a focusable one (`a`, `button`, `select`, `[tabindex]`, `.btn`, …) when no focus rule in the same stylesheet replaces it (box-shadow, border, background, a mixin, `:focus-within` / `:has(:focus-visible)` on a wrapper). High confidence for plain CSS `:focus` rules; SCSS / Less partials and broad selectors are medium. **Classes**: Tailwind `outline-none` / `outline-hidden` / `focus:outline-none` on a focusable native element with no `focus:` / `focus-visible:` ring, outline, border, shadow or background class, no `focus-within:` wrapper and no `group-focus` / `peer-focus` indicator. Skipped: `:focus:not(:focus-visible)`, text inputs and textareas (the caret shows focus), `tabindex="-1"`, composite widgets (`listbox`, `menu`, `grid`, `aria-activedescendant`), components (their own definitions are checked), generated Tailwind CSS |
| `iframe-title` | 4.1.2 (A) | serious | `<iframe>` without `title` |
| `aria-hidden-focusable` | 4.1.2 (A) | serious | focusable element on or inside `aria-hidden="true"` |
| `aria-role-valid` | 4.1.2 (A) | serious | `role` value is not a WAI-ARIA role (suggests the closest, e.g. `buton` → `button`) |
| `aria-attr-valid` | 4.1.2 (A) | serious | misspelled / unknown `aria-*` attribute (suggests the closest) |
| `meta-viewport-zoom` | 1.4.4 (AA) | critical | `user-scalable=no` or `maximum-scale` < 2 |
| `video-captions` | 1.2.2 (A) | serious | `<video>` without `<track kind="captions">` (skipped if `muted`) |
| `no-distracting-elements` | 2.2.2 (A) | serious | `<marquee>`, `<blink>` |
| `no-autofocus` | 2.4.3, 3.2.1 (A) | minor | `autofocus` outside a dialog |
| `autocomplete-valid` | 1.3.5 (AA) | serious / moderate | `autocomplete` on `input` / `select` / `textarea` that is not `on`, `off` or a valid autofill token sequence (`[section-*] [shipping\|billing] [home\|work\|mobile\|fax\|pager] <field> [webauthn]`). Typos and common aliases (`emial`, `firstname`, `zip`) are high confidence with the intended token; autofill-off hacks (`"false"`, `"nope"`) are moderate, medium confidence |
| `label-in-name` | 2.5.3 (A) | serious | button, link, `input type="submit"` or widget role whose static `aria-label` does not contain its static visible text (word match, case- and punctuation-insensitive). Skipped for single characters / symbols, `sr-only` text, dynamic or component content, and when the `aria-label` is itself part of the visible text. All words present but reordered: medium confidence |
| `table-headers` | 1.3.1 (A) | serious | `<table>` with no `<th>`, `scope`, `headers` or header role: a `<thead>` row of `<td>` (high), or ≥2 rows × ≥2 columns (medium). Skipped for `role="presentation"`, nested (layout) tables and rows rendered by components or helper calls |
| `duplicate-id-ref` | 1.3.1, 4.1.2 (A) | serious | static `id` used on two elements that render together, when a `<label for>`, `aria-labelledby`, `aria-describedby`, `aria-controls`, `headers`, `list`, … points to it. Skips conditional branches (`v-if`/`v-else`, `{#if}`, `{a ? … : …}`), separate JSX components and HTML `<template>` content |
| `tailwind-contrast` | 1.4.3 (AA) | serious (medium confidence) | text with a base `text-*` color on the nearest `bg-*` (self or ancestor) below 4.5:1, or 3:1 for large text (`text-2xl`+, or `text-xl` + `font-bold`). Colors come from Tailwind's default palette (must fail under both v3 and v4 values) or arbitrary hex (`text-[#777]`). Silent when either color is unknown: bound classes, theme colors, opacity / alpha, gradients, a component in between, inline styles. Disabled, `sr-only` and symbol-only text are skipped |

**MDX** (`.mdx`) is scanned like JSX: JSX / HTML elements and `{expressions}`, plus Markdown headings,
links and images (`## Title`, `[text](url)`, `![alt](src)`) as `<h2>`, `<a>` and `<img>`. Frontmatter,
`import` / `export` blocks and fenced code are skipped, and inline code counts as text.

Suppress a reviewed false positive with a comment on the line above the element, *with a
reason*:

```html
<!-- wcag-audit-ignore img-alt: 1x1 tracking pixel, removed from the a11y tree by CSP -->
```

```jsx
{/* wcag-audit-ignore img-alt: decorative, parent sets aria-hidden */}
```

`wcag-audit-ignore-file` anywhere in a file skips it entirely.

**Angular:** `.component.html` templates and inline `template:` strings in `@Component({...})`
(`.ts` files; other TypeScript is skipped and not counted) are parsed as HTML with Angular
syntax: `(click)`, `[attr.aria-label]`, `*ngIf`, `@if {}`. Valueless camelCase attribute
directives (`<div ngCombobox>`, `<li cdkMenuItem>`) may add a role and keyboard handling, so
`no-div-button` and `interactive-role-keyboard` skip elements that carry one; `<button pButton
label="…">` counts as named.

## Runtime rules (browser)

Run by `wcag-audit-skill scan <url>`.

- **axe-core** — every rule tagged `wcag2a`, `wcag21a`, `wcag22a` and (default level AA)
  `wcag2aa`, `wcag21aa`, `wcag22aa`; AAA with `--level AAA`; best-practice rules with
  `--best-practice`. Rule ids are prefixed `axe/` (e.g. `axe/color-contrast`). Each
  violation is re-run on the flagged nodes before it is reported; anything that does not
  reproduce is discarded (counted in `summary.discarded`).
- **`keyboard-trap`** (2.1.2, critical) — tabs through the page; reports when focus cycles
  inside a subset of controls, outside an `aria-modal` dialog, and still cannot escape after
  Escape + Tab.
- **`focus-visible`** (2.4.7, serious, medium confidence) — compares each focused element's
  outline, box-shadow, border, colors, text decoration and transform against its unfocused
  state. Candidates are then verified with a pixel check: the element is focused by Tab, the
  area around it is screenshotted focused vs blurred, and any visible change (a ring on
  `::after`, on a child or sibling, a skip link sliding in) drops the finding. Areas that are
  animated or off screen can't be checked and are reported at `low` confidence.

## Not covered by automation

See [MANUAL-CHECKLIST.md](MANUAL-CHECKLIST.md). Alt-text *quality*, meaningful sequence,
captions *accuracy*, reflow at 320px, error identification, and most of WCAG 2.2's new
criteria (2.4.11 Focus Not Obscured, 2.5.7 Dragging, 3.3.7 Redundant Entry, 3.3.8
Accessible Authentication) need human or agent judgment.
