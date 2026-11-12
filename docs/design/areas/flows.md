# Flows

No new component class. A flow line is the existing `row` with one `badge`: its text is the line's state ("2 changes behind", "up to date", "not read lately") and its tone follows the link's health (`attn` for news or not read lately, `danger` for diverged or unreadable, default otherwise). An action under the *Flows in* card is the existing secondary `btn`.

The page draws them as a picture (#9595): `.flow-map` is a three-column grid, sources (`.flow-in`) on the left, the repository's name (`.flow-hub`, with `.flow-arrow` and `.flow-name`) between, followers (`.flow-out`) on the right. The columns stack below 900 px. All server-rendered, no script.

The hub uses `--muted` for the arrows and `--fg` for the name; no accent is used on it, so the one-accent rule holds. The arrows are text glyphs and decoration only: the hub is `aria-hidden` because `repoHeader` already names the repository. Stacked, the reading order is *Flows in*, *Packages*, *Flows out*. The name wraps and the hub column is capped at 24ch so a long name cannot squeeze the sides.

Findings (`findingsPage()` in `src/web/pages/findings.ts`, #9869), reached from the flows view's "Code scanning" line, adds no class and has no card: the list is a `<section>` under one `<h2>`, each finding a `row()` in `<ul class="list">`, open high first, with the accept-with-reason form under it for a writer only; with none, one plain sentence, "Nothing found." The matched text is never drawn. Pinned by `test/findings-language.test.ts`.
