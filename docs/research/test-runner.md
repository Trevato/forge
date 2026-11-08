# Test runner spike: `--isolate`, `--parallel`, `--changed` (#7788)

Bun 1.3.14, the real suite (1738 files), measured 2026-11-02 on an 80-core box.
The first half of #7788 (every shard runs to the end, a crash outside any test
re-runs its shard once) landed in #7817; this records the numbers for the rest.

## `--isolate` and `--parallel`

A sample of 59 test files (every 29th), 357 tests, all green in every mode:

| mode | wall time | crashes ("closed database", unhandled error) |
|---|---|---|
| one `bun test`, no flags | 85 s | 0 |
| one `bun test --isolate` | 155 s | 0 |
| one `bun test --parallel=8` | 36 s | 0 |
| `scripts/test-shards.ts`, 8 shards (one `bun test` per file) | 34 s | 0 |

- `--isolate` costs 1.8x the time of a shared global and, run alone, adds
  nothing the runner lacks: it already spawns one `bun test` per file, so a
  leaked timer or closed socket dies with its process.
- `--parallel=8` is as fast as the runner (36 s against 34 s) and no safer: it
  is the same one-file-per-worker isolation, but loses the runner's weighing
  by recorded time, the crash re-run, the per-shard log and the impact map.
- Each mode ran once: there is no spread. 34 s against 36 s is a tie, not a
  win; only the 85 s / 155 s gap to the others is large enough to read.
- No run crashed on this sample, so it cannot show whether `--isolate` removes
  the "closed database" class. That question is unanswered: it was not
  reproduced under load. The sample is 59 of 1738 files (3%), so a slow or
  crash-prone file outside it is unmeasured. What is known is only that the
  runner's re-run absorbs a crash outside any test, whatever its cause.

Adopted: nothing. Replaces nothing, so nothing is deleted.

## `--changed` against the current selection

`scripts/compare-changed.ts --pulls 15` (the last 15 merged pulls; the fast
tier's pick against `bun test --changed=<parent>`, against the files red in
the pulls' logs):

| | files selected (sum) | missed reds |
|---|---|---|
| fast tier (`fastSet`) | 15 721 | 3 |
| `--changed` | 19 769 | 2 |

`--changed` picks more files and still misses reds, and the script's verdict
is `neither`. The window is 15 pulls, not the script's default 50, and the gap
is 3 against 2 missed reds, so the verdict rests on very few reds; the full 50
was not run.

Probes in a scratch repo (Bun 1.3.14):
- an edit to a statically imported `.ts` selects the test;
- a constant expression, `import("../src/" + "b.ts")`, is followed (it is not
  really dynamic);
- a computed path, `import("../src/" + name + ".ts")`, is not followed: editing
  `src/b.ts` and `src/c.ts` alike printed "no test files are affected";
- an edit to a `.sql` file read with `readFileSync` selects nothing (0 files).

The impact map (`src/checks/impact.ts`) is built differently: it records the
`src/**` files each test executed, from coverage of the full run, so a computed
import that ran is in it. It reads lcov, so a data file such as `.sql` is
covered only if something else records it; that was not probed here.

Adopted: nothing; the fast tier stays.
