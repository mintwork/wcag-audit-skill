# WCAG Accessibility Audit v0.1.2

**WCAG 2.2 accessibility checks in every pull request, now on the GitHub Marketplace.** Scans
HTML, JSX/TSX, Vue, Svelte and Astro source (and optionally a running URL in a real browser), and
reports findings in GitHub code scanning, mapped to WCAG success criteria with a fix for each.

## Use the Action

```yaml
name: accessibility
on: [pull_request]
permissions:
  contents: read
  security-events: write   # upload SARIF to code scanning
jobs:
  wcag:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: mintwork/wcag-audit-skill@v0
        with:
          targets: src       # paths and/or URLs, space-separated
          fail-on: serious   # critical | serious | moderate | minor | none
```

| Input | Default | |
|---|---|---|
| `targets` | `.` | Space-separated paths and/or URLs to scan |
| `fail-on` | `serious` | Lowest severity that fails the check |
| `sarif-file` | `wcag-audit.sarif` | Where to write the SARIF report |
| `upload-sarif` | `true` | Upload to code scanning (needs `security-events: write`) |
| `args` | | Extra CLI arguments |
| `version` | | Run a published npm version instead of the action's source |

**Outputs:** `exit-code`, `sarif-file`.

## Or let your coding agent fix it

The same audit ships as an agent skill for Claude Code, Codex and Cursor:

```bash
/plugin marketplace add mintwork/wcag-audit-skill     # Claude Code
npx @mintwork/wcag-audit-skill scan src/              # CLI
```

## What's new in 0.1.2

- Action metadata for the GitHub Marketplace listing.
- Released with npm trusted publishing (OIDC): no npm token exists for this package, and every
  version carries signed provenance.

Full feature list: [v0.1.0](https://github.com/mintwork/wcag-audit-skill/releases/tag/v0.1.0) ·
[Changelog](https://github.com/mintwork/wcag-audit-skill/blob/main/CHANGELOG.md)
