# Phase 5 — Reporting

Produce three things in `.wcag-audit/`:

1. `findings.json` — machine-readable, conforms to `assets/report-schema.json`.
2. `REPORT.md` — human-readable summary.
3. A short chat summary for the user.

## findings.json

```json
{
  "schemaVersion": 1,
  "standard": "WCAG 2.2 AA",
  "scope": { "paths": ["src"], "urls": ["http://localhost:3000/"] },
  "generatedAt": "2026-01-01T12:00:00Z",
  "findings": [
    {
      "id": "a1b2c3d4e5f6",
      "ruleId": "no-div-button",
      "verdict": "confirmed",
      "title": "Clickable non-interactive elements must be real controls",
      "wcag": ["2.1.1", "4.1.2"],
      "level": "A",
      "severity": "critical",
      "confidence": "high",
      "source": "static",
      "locations": [{ "file": "src/components/ProductCard.tsx", "line": 14, "column": 7 }],
      "evidence": "<div className=\"buy\" onClick={onBuy}>",
      "impact": "Keyboard and screen-reader users cannot buy the product.",
      "verification": "Read ProductCard.tsx: the div is the only purchase control; no role, tabIndex or key handler; rendered on /product/*.",
      "fix": {
        "status": "applied",
        "summary": "Replaced the div with <button type=\"button\">.",
        "files": ["src/components/ProductCard.tsx"]
      }
    }
  ],
  "notTested": ["Screen-reader announcement of live regions", "Reflow at 320px"]
}
```

Rules:
- Keep the CLI's `id` when a finding came from the CLI (so `verify` can match it).
- `verification` is required for `confirmed` and `rejected` — state the evidence.
- `needs_validation` findings carry a `question` for the user and no applied fix.
- `fix.status`: `applied`, `proposed` (needs user sign-off), `not_applicable`, `blocked`.

Validate before reporting:

```bash
node <skill-dir>/scripts/validate-findings.mjs .wcag-audit/findings.json
```

## REPORT.md

```markdown
# Accessibility audit — <project> (<date>)

Standard: WCAG 2.2 AA · Scope: src/, http://localhost:3000 (home, signup, cart)

| | critical | serious | moderate | minor |
|---|---|---|---|---|
| Confirmed | 3 | 5 | 2 | 1 |
| Fixed     | 3 | 4 | 2 | 1 |

Needs your input: 2 · Rejected (false positives): 4

## Fixed
- **Buy button was a `<div>`** (2.1.1, critical) — `ProductCard.tsx:14` → `<button>`.
…

## Needs your input
- **Hero image alt text** (1.1.1) — `Hero.tsx:8`: what should the image communicate?
…

## Not fixed
- **Brand gray fails contrast** (1.4.3) — token `--gray-400` is 2.8:1 on white. Proposed `--gray-600` (5.7:1); needs design sign-off.

## Not tested
Automated + agent review cannot establish conformance. Still required: screen-reader pass
(VoiceOver/NVDA), 200%/400% zoom and reflow, captions accuracy, cognitive review.
```

## Chat summary

Five lines max: what you scanned, counts by verdict, what you fixed, the top item that
needs the user, and where the report is. Do not paste the whole report.

## CI

Suggest wiring the CLI into CI so regressions are caught (see the project README for the
GitHub Action, which uploads SARIF to code scanning):

```bash
npx @mintwork/wcag-audit-skill scan src --sarif -o wcag.sarif --fail-on serious
```
