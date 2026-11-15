# Reddit

Post one at a time, a day or two apart, and answer comments. Attach `docs/demo.gif` where
the subreddit allows media. Check each subreddit's self-promotion rules first.

---

## r/ClaudeAI

**Title:** I made a Claude Code skill that audits your UI for accessibility and fixes it (WCAG 2.2)

**Body:**

Claude writes a lot of my UI, and it writes the same accessibility bugs most of the web has:
inputs with only a placeholder, icon buttons with no name, clickable divs you can't reach
with a keyboard.

So I built `wcag-audit`, an Agent Skill plus CLI. Install it and say "audit this for
accessibility and fix it". Claude then runs a phased procedure:

1. **Static scan** of HTML/JSX/TSX/Vue/Svelte/Astro (24 rules, each tied to a WCAG criterion)
2. **Runtime scan** in a real browser: axe-core plus a Tab-through-the-page keyboard check
3. **Verification**: Claude tries to *disprove* each finding (traces props, checks the DOM)
4. **Fix**: native HTML first, minimal diffs, and it asks you instead of inventing alt text
5. **Report**: JSON + SARIF, and `verify` shows resolved / remaining / introduced

Install:

```
/plugin marketplace add mintwork/wcag-audit-skill
/plugin install wcag-audit@wcag-audit-skill
```

It also works in Codex (AGENTS.md), Cursor, or as `npx @mintwork/wcag-audit-skill scan ./src`.

Tested on 10 real codebases (6,880 files) and 7 live pages with hand-checked findings: 91%
true positives on the latest sample, 0 false positives. It can't replace a screen-reader
test, and the report says so.

Repo: https://github.com/mintwork/wcag-audit-skill. Feedback on the skill
instructions is very welcome.

---

## r/webdev

**Title:** Open-source CLI: one accessibility scan for HTML, React, Vue, Svelte and Astro, with WCAG mapping, fixes and SARIF

**Body:**

I wanted one accessibility check that works across the frameworks I touch, gives file:line,
tells me which WCAG criterion failed and how to fix it, and plugs into GitHub code scanning.

```
npx @mintwork/wcag-audit-skill scan ./src                 # static: HTML / JSX / TSX / Vue / Svelte / Astro
npx @mintwork/wcag-audit-skill scan http://localhost:3000 # runtime: axe-core + keyboard checks in Chrome
npx @mintwork/wcag-audit-skill scan ./src --sarif -o a11y.sarif
```

Each finding looks like:

```
CRITICAL no-div-button  WCAG 2.1.1 Keyboard, 4.1.2 Name, Role, Value (A)
         src/Checkout.tsx:8:7
         <div> has a click handler but no role, is not focusable, and no keyboard support.
         fix: Replace <div> with <button type="button"> ...
```

What I focused on:

- **Low false positives.** Spread props, bound values and components that might render text
  are assumed fine; heuristics are marked medium confidence. On 10 real codebases the latest
  hand-reviewed sample was 91% true positives with 0 false positives.
- **Speed.** About 3,300 files/s.
- **Real browser checks.** axe-core results match raw axe; a Tab traversal finds keyboard
  traps and invisible focus with a pixel check.
- **CI.** SARIF output, a GitHub Action, exit codes by severity, suppression comments with
  a reason.

It's also an agent skill (Claude Code, Codex, Cursor) that fixes what it finds, but the CLI
stands alone. MIT. Keep your eslint a11y plugin; this complements it.

https://github.com/mintwork/wcag-audit-skill

---

## r/accessibility

**Title:** Built an automated WCAG 2.2 audit for AI coding agents. Looking for feedback from practitioners on what it gets wrong.

**Body:**

AI coding tools are generating a lot of new UI, and much of it fails basic WCAG checks. I
built an open-source skill and CLI that makes the agent audit and fix its own output, and I'd
like people who do this work for real to poke holes in it.

What it does:

- Static checks on source (HTML, React, Vue, Svelte, Astro) for names, labels, alt text,
  keyboard operability of custom controls, heading order, `lang`, viewport zoom, captions
  and ARIA validity, each mapped to a 2.2 success criterion.
- axe-core in a real browser, plus a keyboard pass for traps (2.1.2) and visible focus (2.4.7).
- The agent must verify each finding before fixing it, prefers native elements over ARIA,
  and is told never to invent alt text or labels. It asks the user what an image conveys.

What it does **not** do, and says so in every report: certify conformance. Automated checks
catch roughly 30 to 50% of failures. Reports end with a manual checklist: screen reader pass,
zoom and reflow, caption accuracy, cognitive load, and so on.

Questions for this sub:

1. Which failures do you see most in AI-generated UI that a tool like this should catch?
2. Is the fix guidance in the rules reference sound? I'd especially like a review of the
   fix patterns for custom widgets.
3. What should the "needs a human" section of the report always include?

Repo and rules list: https://github.com/mintwork/wcag-audit-skill (MIT).
