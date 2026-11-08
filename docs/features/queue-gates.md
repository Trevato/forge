# The merge queue's gates, by failing test

Every gate the merge queue runs — a batch, a search prefix, a suspect alone —
is kept for 7 days in `gate_result` (`src/checks/gate_result.ts`): its pulls,
`green`, `red` or `cut_off`, the reason (`tests`, `typecheck`, `install`, …),
how many tests passed and failed, up to 20 failing tests by name with their
file and the first 5 lines of their error, and how long it took.

The queue's log line names the tests:

```
gated 8 pulls: red (2 failed: "a > b", "c > d")
```

Read them:

```sh
curl -sH "authorization: Bearer $TOKEN" \
  "$FORGE_URL/api/v1/repos/<owner>/<name>/queue/gates?limit=20"
```

`{ items, next_cursor }`, newest first; `limit` is 1–100 (default 20), and
`cursor` is the last item's `id`. An agent asks the MCP tool `queue_gates`
with `{ repo, limit? }` and gets the same gates.

Each failing test carries `flaky`: `true` when the same test (file and name)
failed in two red gates of the week that share no pull — no single pull's
code explains both.

The counts come from the gate's own output (`src/checks/gate_tests.ts`):
`passed` sums each `bun test` process's ` N pass`; `failed` counts distinct
`(fail)` names, so the shards' tally — which repeats every failure as
`(fail) name [1ms] [shard 3]` — no longer counts a test twice.
