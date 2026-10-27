# Budget reds in a merge-queue gate (#7354)

A budget test (`expectBudget`, `test/helpers/budget.ts`) can fail only under the
gate's own load, while main and the pull pass it alone. When a red merge-queue
gate is red **only** on budget tests, the gate re-runs those test files once,
serially, before the batch counts as red (`src/checks/budget_retry.ts`, wired
in `checks/service.ts`).

- **Which reds count.** `expectBudget` throws `over budget (expectBudget): …`
  when a time is over its limit, and bun prints a test's error just above its
  `(fail)` line. A gate is a budget red when every `(fail)` comes after that
  error, each has a file, the fail counts add up, and the log has no error
  outside a test, no shard that named no test, and no skipped shards. At most
  four files. Anything else is a functional red, searched at once with no re-run.
- **The re-run.** `bun test --max-concurrency=1 './file' …` in the same checkout
  and cell, with `FORGE_TEST_QUIET=1`, so each budget is held to its absolute ms.
  It passes: the gate is **green**, the batch lands, and each test is a row in
  `check_flake` (the flake list; twice in a week files an issue, as
  [check-flake](check-flake.md)). It fails: **red, as before**.
- **Only the test files re-run.** A green re-run turns the whole check green,
  as main's flake re-run does. That is sound for this forge: `check.run` ends
  with `test-shards`. A repository whose gate runs more steps after its tests
  (`… && test-shards … && more`) has those steps skipped on a budget red, and a
  green re-run lands the batch without them ever running.
- **The shards run on.** `scripts/test-shards.ts` stops the other shards at the
  first red (fail-fast), except a shard red only on budget tests: the gate can
  only be called green when every other file ran too.
- **The tick line** says `budgetRetries="P passed/F failed"` for the last hour's
  re-runs when there were any. Re-runs that keep failing mean a budget is truly
  regressed.

Left out: the main and pull checks (main has its own flake re-run), cluster
Jobs (the re-run needs the check's own cell), and a `budget` tag in a test's
name. Only `expectBudget`'s own error counts, so a raw `toBeLessThan` or a test
that only says "budget" in its name is never re-run.
