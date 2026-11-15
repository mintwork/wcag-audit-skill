# Contributing

Thanks for helping make the web usable for everyone. Bug reports with a minimal snippet are
the most valuable contribution: **false positives** (we flagged correct code) and **false
negatives** (we missed a real failure) both make the tool better.

## Setup

```bash
npm install
npm test            # builds (tsc) then runs vitest
```

Runtime tests need a Chromium browser. They use Playwright's Chromium if installed
(`npx playwright-core install chromium`), otherwise local Chrome/Edge, and are skipped with
a warning if none is found.

## Project layout

```
src/
  static/            source analysis
    parse-html.ts    tolerant parser for HTML, Vue, Svelte, Astro
    parse-jsx.ts     JSX/TSX via @babel/parser
    ast.ts           framework-neutral element tree + attribute normalization
    helpers.ts       accessible-name approximation, focusability, etc.
    rules.ts         all static rules
    analyze.ts       file discovery, suppression comments, fingerprints
  runtime/           Playwright + axe-core scan, keyboard traversal
  report/            text / JSON / SARIF
  cli.ts             argument parsing
skills/wcag-audit/   the Agent Skill (SKILL.md, references, schema, validator)
integrations/        Codex (AGENTS.md), Cursor, Claude Code docs
test/fixtures/       known-bad and clean files for every parser
```

## Adding a static rule

1. Add an entry to `rules` in `src/static/rules.ts`: `id` (kebab-case), `title`, `wcag`
   criteria, default `severity`, one-line `description`, and a `create(ctx)` that calls
   `ctx.report({ el, message, fix })`.
2. **Be conservative.** If an attribute is dynamic (`attr.dynamic`), the element has a spread
   (`el.hasSpread`), or a child is a component (`isComponent`), assume the author handled it.
   Use `confidence: "medium"` for heuristics.
3. Messages say what is wrong *for the user*; fixes are concrete and copy-pasteable.
4. Add the violation to the relevant `test/fixtures/static/bad/*` file and a correct version
   to `test/fixtures/static/good/*` (the good fixtures must stay at zero findings), plus a
   false-positive guard in `test/static.test.ts`.
5. Document it in `skills/wcag-audit/references/RULES.md` and the README rule table, and add
   a fix pattern / verification note to the skill references if useful.
6. If the criterion is new, add it to `src/wcag.ts`.

## Changing the skill

`skills/wcag-audit/SKILL.md` must follow the [Agent Skills spec](https://agentskills.io/specification):
`name` matches the directory, `description` ≤ 1024 chars, body < 500 lines. Put detail in
`references/`. `test/skill.test.ts` checks this and that every linked file exists.

## Demo GIF

`docs/demo.gif` is generated, not recorded: `npm run demo:gif` builds the CLI, runs it on
the synthetic fixtures in `test/fixtures/static`, renders the real ANSI output in a terminal
page with Playwright (Google Chrome) and encodes it with ffmpeg (`FFMPEG=/path/to/ffmpeg`
to override). The script is `scripts/demo-gif.mjs`; it fails if the GIF exceeds 5 MB.
Regenerate it when the text output changes. Never record real projects or third-party sites.

## Releasing

Versions follow semver. The GitHub Action is consumed as `mintwork/wcag-audit-skill@v0`,
so every release gets an immutable `vX.Y.Z` tag and the major tag `v0` is moved to it. The
[release workflow](.github/workflows/release.yml) does the npm publish and the tag move when a
GitHub Release is published. The action builds the CLI from the tagged source, so tags must point
at commits where `npm ci && npm run build` works.

1. Update `version` in `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and
   `skills/wcag-audit/SKILL.md` (`metadata.version`); move the `Unreleased` entries in
   `CHANGELOG.md` under the new version; add `docs/release-notes-vX.Y.Z.md`. Commit and push.
2. `npm ci && npm run typecheck && npm test`, and check `npm pack --dry-run` lists only
   `dist/`, `skills/`, `integrations/`, `.claude-plugin/`, README, CHANGELOG and LICENSE.
3. Create the release; the workflow checks that the tag matches `package.json`, runs the tests,
   publishes to npm with provenance and moves `v0`:

   ```bash
   gh release create v0.2.0 --title "v0.2.0" --notes-file docs/release-notes-v0.2.0.md
   ```

   Never move or delete a `vX.Y.Z` tag once pushed. A breaking change to action inputs or
   outputs needs a new major tag (`v1`): change it in the release workflow first.

**npm auth:** [trusted publishing](https://docs.npmjs.com/trusted-publishers) only; no npm token
is stored in the repository. npm accepts publishes of this package only from `release.yml` in
`mintwork/wcag-audit-skill` (set under the package's Settings → Trusted Publisher on npmjs.com). A version
already on npm is skipped, and manual runs of the workflow are dry runs.

## Commits and PRs

- Small, focused PRs with tests. `npm test` must pass.
- Conventional-ish commit messages (`feat:`, `fix:`, `docs:`, `test:`).
- By contributing you agree your work is released under the MIT license.

## Accessibility of this project

Docs and examples should model good practice: descriptive link text, alt text on images,
tables with headers. If you spot something in this repo that is itself inaccessible, that's
a bug — please report it.

## Publishing to Agensi

[Agensi](https://agensi.io) has no API or CI publishing, so every GitHub Release gets a
ready-to-upload package attached (`*-agensi.zip`, built by `npm run build:agensi`). The build adds
Agensi's listing fields (`version`, `summary`, `tags`, `docs_url`) to the packaged `SKILL.md` only
and checks Agensi's limits (100 files, 5 MB, text only). To publish or update the listing, either
upload the ZIP in Agensi's Creator Studio, or ask an agent connected to Agensi to `update_skill`
from it.
