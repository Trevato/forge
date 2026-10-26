---
description: Talk to your forge: tell, status, decide, plan
argument-hint: tell <app> <words> | status | decide <approve|redirect|decline> [words] | plan [approve|redirect <words>|later]
---

Use the `forge` MCP server's tools for `$ARGUMENTS`.

- `tell <app> <words>`: call `tell` with `repo` = the app (owner/name) and `text` = the words. Pass `context` with `page` (if known), `run`, `commit` (the current `git rev-parse HEAD`) and `said` (the person's own words, verbatim).
- `status`: call `now` and `asks`; say in three sentences what is running and what waits on the person.
- `decide approve|redirect|decline`: call `asks`, take the first row; approve → `asks_act` with action `ship`, decline → `asks_act` with action `close`, redirect → `say` with the person's words. Plan first (`dryRun` defaults to true), show what would change, and apply (`dryRun: false`) only after the person says yes.
- `plan`: call `asks`, take the first row whose kind is `proposal` (none: say no wave waits). Show it in three lines: the wave's title, what it holds, why now. With `approve`, `redirect <words>` or `later`, ask the person to confirm, and only after they say yes call `asks_proposal` with `id` = that row's `proposal.id` (the proposal's own id, not the row's `id`, which starts `proposal:`), `verb` = the word, and `words` for redirect.

Keep what you relay short. Never merge: a person lands changes.
