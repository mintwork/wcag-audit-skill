# Phase 4 — Fix patterns

Smallest correct fix, in the framework's idiom. Each pattern: before → after → the
one-sentence explanation to give the user.

## Clickable `<div>` → `<button>` (`no-div-button`, 2.1.1 / 4.1.2)

```jsx
// before
<div className="buy" onClick={onBuy}>Buy now</div>
// after
<button type="button" className="buy" onClick={onBuy}>Buy now</button>
```

> The "Buy now" control was a `<div>`, so keyboard and screen-reader users could not reach or
> activate it. It is now a `<button>`, which is focusable and responds to Enter/Space.

Reset button styles if needed (`background: none; border: 0; padding: 0; font: inherit;
color: inherit; text-align: inherit`) rather than keeping the `div`. Navigation → `<a href>`.
Only if a native element is truly impossible: `role="button" tabIndex={0}` **plus**
`onKeyDown` handling Enter and Space.

## `<a onClick>` → `<button>` (`anchor-is-button`)

```vue
<!-- before -->  <a href="#" @click.prevent="openMenu">Menu</a>
<!-- after  -->  <button type="button" @click="openMenu">Menu</button>
```

## Missing alt (`img-alt`, 1.1.1)

```html
<img src="/chart-q3.png" alt="Revenue doubled in Q3, from $1.2M to $2.4M">   <!-- informative -->
<img src="/divider.svg" alt="">                                            <!-- decorative -->
<a href="/"><img src="/logo.svg" alt="Acme home"></a>                        <!-- functional: describe the action -->
```

Write alt from what the image *communicates in context*. Derive it from nearby copy,
file names only as a hint, or the image itself if you can view it. If unsure →
`needs_validation`, ask the user. Never `alt="image"`.

## Mechanical fixes (CLI)

`html-lang` repairs, `meta-viewport-zoom` and `aria-attr-valid` typos have one correct answer, so
the CLI can apply them: `npx @mintwork/wcag-audit-skill scan <path> --dry-run` prints a unified diff,
`--fix` applies it (add `--lang <code>` for a missing `lang` once you know the language). Show
the user the diff before `--fix`.

## Unlabeled input (`form-label`, 1.3.1 / 3.3.2 / 4.1.2)

```jsx
// React
<label htmlFor="email">Email</label>
<input id="email" type="email" autoComplete="email" />
// or, with useId for reusable components
const id = useId();
<label htmlFor={id}>{label}</label><input id={id} {...props} />
```

```svelte
<label>Email <input type="email" bind:value={email} /></label>
```

When the design has no visible label (search boxes), use a visually hidden label or
`aria-label` — but prefer a visible label for anything beyond search. Placeholder stays
as a hint only.

## Icon-only button / link (`button-name`, `link-name`, 4.1.2 / 2.4.4)

```jsx
<button type="button" aria-label="Close dialog" onClick={close}>
  <XIcon aria-hidden="true" />
</button>
```

If the codebase has an `IconButton`, make `label` a **required** prop and set
`aria-label` inside it — fix once, fixed everywhere.

## Heading order (`heading-order`, 1.3.1)

Change the level, keep the look: `<h4 class="text-lg">` → `<h3 class="text-lg">`.
For reusable components, accept a level prop (`as="h3"`) instead of hard-coding.

## Language / title / zoom (3.1.1, 2.4.2, 1.4.4)

```html
<html lang="en">
<title>Checkout – Acme Store</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
```

Next.js: `<html lang>` in `app/layout.tsx`, `export const metadata = { title }`. Nuxt:
`useHead({ htmlAttrs: { lang: 'en' }, title })`. SvelteKit: `src/app.html` +
`<svelte:head><title>`.

## Positive tabindex (2.4.3)

Remove `tabindex="3"` (native controls) or use `tabindex="0"`, then reorder the DOM to
match the visual order. Never renumber tabindex values.

## Focus visible (2.4.7)

```css
/* Do not remove outlines without a replacement */
:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
```

Tailwind: replace `focus:outline-none` with `focus-visible:outline-none
focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-600`.

## Color contrast (1.4.3)

Use the foreground/background colors axe reports. Pick the nearest color in the
project's palette/tokens that reaches 4.5:1 (3:1 for ≥24px or ≥18.66px bold). Change
the **token** if the failing color is a token used in many places — and ask first, since
this changes the visual design.

## Keyboard trap (2.1.2)

Remove handlers that `preventDefault()` Tab or re-focus on blur. For modals, trap focus
only while open, close on Escape, and return focus to the trigger. Prefer the native
`<dialog>` element with `showModal()`, which handles all three.

## ARIA typos and invalid roles (4.1.2)

`aria-lable` → `aria-label`; `role="buton"` → use `<button>`. Remove ARIA that
duplicates native semantics (`<button role="button">`).

## `aria-hidden` on focusable content (4.1.2)

Use the `inert` attribute on the hidden region (off-screen drawers, background content
behind a modal) instead of `aria-hidden` alone.

## Video captions (1.2.2)

```html
<video controls src="/promo.mp4">
  <track kind="captions" src="/promo.en.vtt" srclang="en" label="English" default>
</video>
```

You cannot author accurate captions without the audio: add the `<track>` wiring and mark
the finding `needs_validation` with "caption file required".

## Explaining fixes

For each fix, tell the user in plain language:
1. **What was wrong** — the element and the criterion.
2. **Who it affected** — keyboard users, screen-reader users, low-vision users, voice-control users.
3. **What changed** — the diff in one sentence, and anything they must still do (copy, captions, design sign-off).
