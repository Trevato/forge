# A repeated review comment becomes a check (#8716)

Once a reviewer asks for the same thing four times in a week, a rule says it for them.

- **Grouped cheaply.** `src/flow/repeats.ts` reads the week's `changes_requested` reviews and review line comments (indexed by time), splits them into list items, and groups them by the words they ask with (code, links, numbers and filler dropped; half the words shared is one finding). No agent run.
- **Proposed once.** `src/crew/repeat_checks.ts`, called from the autonomy tick at most every 6 h per repository, opens one issue per finding seen 4 times (`REPEATS`), at most two per sweep, naming each comment and its pull and asking for a lint or test. The finding is kept in `review_finding`, so it is never proposed twice.
- **Retired.** When that issue closes as `done`, the finding is retired.
- **Shown.** `flow` (MCP `flow.reviewRepeats`, and the terminal flow screen's "Review repeats" line) gives findings proposed and retired beside review comments per pull this week and last. An agent reads public repositories only.

Left out: matching is by shared words, not meaning; a finding is retired when its issue is done, not by proving the check fires.
