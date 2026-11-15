# Phase 3 — Verification

The scanner reports candidates. You are the second, adversarial reviewer: **try to prove
each one wrong**. Only findings that survive become `confirmed`.

## Procedure (every candidate)

1. **Open the source** at `file:line` (or the source you mapped a runtime selector to).
   Read the whole element and its parent component, not just the line.
2. **Trace dynamic values.** If a prop, slot, spread or store supplies the name/label,
   follow it to its definition and to every call site. A required, always-non-empty prop
   disproves `button-name`; an optional one that some caller omits confirms it *for that caller*.
3. **Check the rendered result** when a browser is available: the accessibility tree is the
   ground truth (`page.accessibility.snapshot()`, Chrome DevTools "Accessibility" pane, or
   `axe.run(element)`).
4. **Check reachability.** Dead code, unused components and test fixtures are `rejected`
   (or reported as minor hygiene, not as user-facing failures).
5. **Decide the verdict** and write down the evidence that decided it.

## Rule-specific disproof checks

| Rule | It is a false positive if… |
| --- | --- |
| `img-alt` | the element is not an `<img>` in the DOM (custom component), or a wrapper sets `alt` |
| `img-alt-meaningful` | the "vague" word *is* the content (e.g. a logo whose alt is the company name) |
| `form-label` | a parent component renders `<label for>` with the same id, or `aria-labelledby` is set elsewhere |
| `button-name` / `link-name` | a child component renders visible text or `sr-only` text; the icon component sets `aria-label` |
| `no-div-button` | the handler only stops propagation / the real control is a child `<button>` |
| `anchor-is-button` | a router intercepts and the `href` is real at runtime |
| `heading-order` | the component is always rendered under a heading of the right level (check its parents) — still prefer configurable levels |
| `focus-outline-removed` | another stylesheet or a wrapper component draws the focus state (`:focus-within`, a design-system focus ring), or the element is never keyboard-focusable. Confirm with Tab in the browser (`focus-visible` runtime check) |
| `autocomplete-valid` | never a false positive for an invalid token, but 1.3.5 only applies to fields collecting data *about the user*: an invalid value on a search or filter box is minor hygiene |
| `label-in-name` | the visible text is not the label (e.g. a counter badge), or the name starts with the visible text in another form the user would speak |
| `table-headers` | the table is purely for layout (then add `role="presentation"`), or headers are added by a component the scan did not see |
| `duplicate-id-ref` | the two elements never render at the same time (check the branches and routes) |
| `tailwind-contrast` | the project overrides that palette color (`tailwind.config` `theme.colors`, a v4 `@theme` block), the text is disabled or decorative, or something else (image, overlay, sibling) sits behind the text. Confirm with `axe/color-contrast` at runtime when possible |
| `video-captions` | the video has no speech (decorative loop) — then add `muted` and reject |
| `axe/color-contrast` | text is disabled (`disabled` controls are exempt), purely decorative, or a logo |
| `focus-visible` | focus is shown by a child (e.g. inner `<span>` ring) or a `::before/::after` pseudo-element — inspect styles |
| `keyboard-trap` | it is an intentional modal with an Escape/close button that the scan did not exercise; still check it is `aria-modal` |

## Verdicts

- **confirmed** — Fails the criterion and you can say exactly why. Severity is set by user
  impact here (an unlabeled checkout field is critical; an unlabeled admin filter on an
  internal tool may be serious).
- **needs_validation** — You could not establish the fact: content quality (is this alt
  accurate?), states you could not reach, third-party widgets, design intent. State the
  *exact* question the user must answer. No fix.
- **rejected** — Disproved. Keep it in `findings.json` with the reason; it prevents the next
  run from rediscovering it and tells the user which rule produced noise.

## De-duplication

One root cause = one finding. Merge:
- the same issue found by static and runtime scans (keep both locations);
- the same component bug repeated at many call sites (fix the component, list call sites);
- `axe/label` + `form-label` on the same control.

## Confidence

`high` = you traced it end-to-end or observed it in the browser. `medium` = strong
evidence, one unverified assumption. Anything lower is `needs_validation`, not a finding.
