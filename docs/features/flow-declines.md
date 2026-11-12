# Flow: declined runs

When a crew run reads its issue and declines it (its summary starts `Declined:`), that is a planning mistake worth counting. The Flow views say how many runs declined in the last 24 hours, and why, in one line:

`Declined in 24 h: 3 already on main (#12, #15, #20), 1 other (#9)`

Reasons: *already on main*, *not on main yet*, *off direction*, *other*. Each shows its count and up to three issue numbers (`, …` when more). With no declines the line is absent.

## Where to read it

- **Page:** `/boards`, the muted line under the build yield. Each issue number links to the declining run.
- **Terminal:** the Flow command (palette), the same line under the review latency.
- **Agents:** the `flow` MCP tool with no arguments returns `declines` (`says`, `groups`, `runs`).

One reader serves all three (`readDeclines` in `src/flow/declines.ts`). A site admin sees every repository; an agent or guest reader sees public repositories only. The figure is cached with the rest of the panel for 30 seconds.
