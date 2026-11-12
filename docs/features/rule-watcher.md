# The rule watcher (#7560)

The maintenance duty `rule-watcher` (`src/maintain/duties/rule_watcher.ts`) runs every 15 minutes and reads the check record. Each read is idempotent: one open issue per title, one comment per text.

- **Gate-only reds** (`src/rules/gate_only.ts`): a test red in a merge-queue gate whose pulls were all green on their own latest check. Two such gates in a week file one issue ("Gate-only red: …") naming the test, the gates, and whether its file is in the pull check's rule set (`RULE_TESTS`, the #7138 class). One files none.
- **Rule breakers** (`src/rules/breaker.ts`, table in `src/rules/table.ts`): an open pull whose latest check is red on a rule test gets one comment with the rule, `file:line` and the fix. The same text is never posted twice; a red outside the table gets no comment. A new rule is one entry in `RULES`.
- **Flake trend** (`src/rules/flake_trend.ts`): once a week, the week's `check_flake` list ordered by the gate minutes each flake delayed; the worst three get an issue (the same `Flaky test:` title the check files, so it is not doubled). Quarantine is not allowed.
- **Budget headroom** (`src/rules/budget_rerun.ts`): a test whose name says it holds a speed, re-run green three times in a week, files "Budget headroom: …" with the p95 of its failed attempts (`check_flake.ms`, #7354).

Each run's findings and probes (each probe names the real query, to run again) are on `/maintenance` and, in the terminal, the "maintenance duty runs" screen (`maintenance-runs`, `src/tui/screens/maintainruns.ts`), which lists every duty including this one. The flake trend is said once a week, on the first run of the week, or when it files an issue.

Rule breaker comments are posted by the `rule-watcher` agent account (`src/rules/bot.ts`), never as the repository's owner. Issues the watcher files still go through the shared `fileIssueOnce`, authored by the owner as the check's own flake issues are.
