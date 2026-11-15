# Show HN

**Title** (80 char max):

Show HN: An accessibility audit skill for coding agents (WCAG 2.2, verified findings)

**URL:** https://github.com/mintwork/wcag-audit-skill

**Text:**

Coding agents write a lot of UI now, and they reproduce the web's accessibility habits:
placeholder-only inputs, icon buttons with no name, `<div onClick>` that a keyboard can't
reach. That's not a surprise, since about 95% of the top million home pages have detectable
WCAG failures (WebAIM Million) and that is the training data.

Security-audit agent skills already showed a good pattern: give the agent a phased procedure,
real tools, and make it try to disprove each finding before it reports one. I built the same
thing for accessibility.

wcag-audit-skill is an Agent Skill (SKILL.md) plus a CLI:

1. Static scan of HTML, JSX/TSX, Vue, Svelte and Astro: 24 rules, each mapped to a WCAG 2.2
   success criterion, with evidence and a copy-pasteable fix.
2. Runtime scan: opens the page in real Chromium/Chrome, runs axe-core, then tabs through the
   page to find keyboard traps and focus you can't see (pixel-checked, not just "no outline").
3. Verification: the agent traces props and spreads and checks the rendered DOM to reject
   false positives. Runtime violations are re-run and dropped if they don't reproduce.
4. Fix: native HTML first, minimal diffs, explained. It never invents alt text; it asks.
5. Report: schema-validated JSON plus SARIF for GitHub code scanning. `verify` re-runs the
   checks and prints resolved / remaining / introduced.

It works with Claude Code (plugin), Codex and other AGENTS.md agents, Cursor, and as a plain
CLI or GitHub Action.

I measured it on 10 real codebases (6,880 files across React/Next, Vue, SvelteKit, Astro and
plain HTML) and 7 live pages, hand-checking findings:

- Static precision: 91% true positives on a fresh 43-finding sample, 0 false positives, the
  rest debatable. The first version was 70% with 15% clear false positives, so most of the
  work went into being conservative: spreads, bound values and components that might render
  text are assumed to be fine, and heuristics are labeled medium confidence.
- About 3,300 files/s, 0 crashes on 6,880 files plus 20k truncated-file fuzz runs.
- Runtime matches raw axe-core, and the keyboard-trap check had 0 false alarms.

Limits, honestly: automated checks find roughly 30 to 50% of WCAG failures. This can't certify
conformance, and the report says what still needs a person (screen reader pass, zoom/reflow,
captions, cognitive review). MDX isn't scanned yet, and labels passed in from a component in
another file are only visible to the runtime scan.

MIT, Node 22+, three runtime dependencies. I'd love false-positive reports with a minimal
snippet; those have driven most of the improvements so far.

---

**First comment (post right after submitting):**

Some background on the design choices:

- Why a skill and not only a linter: linters stop at "here is a warning". The useful part is
  the loop: find, verify against the source, fix with the right idiom for the framework,
  re-run. An agent is good at that loop if you give it a procedure and evidence.
- Why static and runtime: static gives file:line and runs in a second on a big repo; runtime
  catches contrast, computed names and focus behavior that source can't show. They overlap
  on purpose.
- Why SARIF: findings show up as PR annotations without another dashboard.

Keep eslint-plugin-jsx-a11y if you use it. This covers more frameworks with one tool and adds
the browser and the fix step.
