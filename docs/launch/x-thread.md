# X thread

Attach `docs/demo.gif` to post 1.

---

**1/**
AI ships inaccessible UIs.

So I built an agent skill that makes it fix them: a WCAG 2.2 audit for Claude Code, Codex
and Cursor, plus a CLI.

Static scan → real browser → verify → fix → report.

github.com/mintwork/wcag-audit-skill

[demo.gif]

**2/**
Ask an agent for a checkout form: placeholder-only inputs, a nameless icon button, and a
"Pay now" `<div>` no keyboard can reach.

A blind user hears "edit text, button, image".

~95% of the top million home pages fail WCAG checks. That's the training data.

**3/**
The skill borrows the shape of security-audit skills:

1. Static: 24 rules, HTML/JSX/Vue/Svelte/Astro, mapped to WCAG
2. Runtime: axe-core in Chrome + keyboard pass
3. Verify: try to disprove each finding
4. Fix: native HTML first, minimal diffs
5. Report: JSON + SARIF

**4/**
Verification is the point: a long list of maybe-issues teaches people to ignore the tool.

Hand-checked on 10 codebases (6,880 files) + 7 live pages:
• 91% true positives, 0 false positives (earlier: 70%, 15% FP)
• ~3,300 files/s
• 0 crashes on 6,880 files + 20k fuzz runs

**5/**
It never invents alt text. If it can't tell what an image means, it asks you.

And after fixing, `wcag-audit-skill verify` re-runs everything: resolved / remaining /
introduced.

**6/**
Honest limits: automation finds roughly 30 to 50% of WCAG failures. This can't certify
conformance, and every report lists what still needs a human (screen reader, zoom, captions).

**7/**
Try it:

Claude Code:
/plugin marketplace add mintwork/wcag-audit-skill

CLI:
npx @mintwork/wcag-audit-skill scan ./src

CI:
uses: mintwork/wcag-audit-skill@v0

MIT. False-positive reports welcome.
