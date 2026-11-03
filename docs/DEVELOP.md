# Develop

Moved from README.md (its "## Develop" section), unchanged.

Driving the forge from a shell — every `forge` command, its flags and one example: [docs/CLI.md](CLI.md).

```sh
bun test              # protocol-level + adversarial suite
bun scripts/design-lint.ts   # no colour or off-scale font-size beyond docs/design/baseline.json, no class docs/DESIGN.md §5 does not name
bun scripts/cold-read.ts <url> [--repo owner/name] [--write [--allow-text-only]] [--file-issues N [--file-into owner/name]]   # cold-read audit (#5882): a no-context model reads the top pages (signed in with FORGE_TOKEN, sent only to FORGE_URL's forge; the signed-in pages go to the model endpoint, so use a throwaway account) at 390 and 1440 px; needs ANTHROPIC_API_KEY
bun x tsc --noEmit    # zero type errors is the standard
bun run check         # exactly what the forge runs against every push
bun run check:record  # the same, and rewrites scripts/test-times.json
```

The design check (`test/design-lint.test.ts`, run in the gate) fails a pull that
adds a colour literal or an off-scale `font-size` beyond
`docs/design/baseline.json`, or defines a class `docs/DESIGN.md` §5 does not
name; the message names the file or the class. The way out is to use a token
(`var(--…)`) or a component §5 names; a new component is named in its own
`docs/design/areas/<area>.md`. When a change lowers the counts, run `bun scripts/design-lint.ts
--update` and commit the baseline; when it deletes the last rule for a class
in the §5d register, strike the name there too. See `docs/design/plan.md`.

`docs/DESIGN.md` is a spine: each of its sections is its own file under
`docs/design/sections/` (§5d is `5d-page-local-classes.md`), linked from the
spine in order, and the check reads them in that order. A new section is a
new file and a new line in the spine.

`bun run check` is the gate: the same command `forge.json` declares, so what
it says here is what the deploy will say. It type-checks once, then runs the
test files `scripts/gate.ts` admits — every `test/*.test.ts` not in its
`EXCLUDED` — as parallel `bun test` shards
(`scripts/test-shards.ts`): one per CPU the process may use, no more than
one per 512 MiB of the memory its cgroup allows (16 on the 16-CPU, 8 GiB
check cell; the old ceiling of eight left half of it idle, #2038), and
`FORGE_CHECK_SHARDS=2` turns that down on a small or busy host. Each
shard's output is written whole as it finishes; the log ends with every
failing test from every shard, or on green with one line — how many tests,
across how many files, in how long, then the slowest and fastest shard.

A shard of several files that goes red gets a second chance for its failing
files, first three only: each is run once alone, same flags and env. A file
that passes alone was red only beside others and no longer fails the check;
the shard's log (and the tail) carries `test-shards: fails only beside
others: <file> (shard-mates: …)`. Only failed tests clear: if the report
holds an error (a file that threw while loading, an unhandled error, a
crash before the summary) nothing in that shard is retried, and a file that
fails alone stays red. `--record`, `--impact` and one-file-per-process runs
never retry. The cleared file is reported in the log only; filing it as an
issue is not built yet (#2480).

Two things keep a test's setup in milliseconds (#2038). `bunfig.toml`
preloads `test/helpers/preload.ts`, which hashes passwords at argon2id's
floor (8 KiB, one pass) instead of Bun's default 64 MiB, two passes:
making an account and signing it in was ~700 ms of a typical `beforeAll`
and is now ~15 ms; the forge itself never loads it. And `openDb` keeps
the empty database each migration list makes: the second fresh database
in a process is a copy of it rather than ninety-odd migrations again
(`createApp` ~100 ms → ~6 ms). No test file runs one subject long
enough to set the gate's floor alone: the studio's and the apps
adversarial suites are split by subject into `test/studio*.test.ts` and
`test/apps-adversarial*.test.ts`.

The check's first step is the gate-list audit (`bun scripts/gate.ts`), so an
`EXCLUDED` entry for a file that is gone, or one with no reason or issue,
fails in under a second,
before install-heavy work. `tsc` then runs `--incremental` with a 2 GB heap,
its build info in `.forge-cache/` (made first with `mkdir -p`: tsc will not
create the directory, and a checkout with no restored cache failed on it,
#1881). It is TypeScript 7, the native compiler (a
Go binary, so the bound is `GOMEMLIMIT=2GiB`): on this tree a cold check is
~3 s and ~17 CPU-s where 5.9 took ~30 s and ~50 CPU-s (#1864). 5.9 stays as
the dev dependency `typescript-api` only because `scripts/hollow.ts` walks
its AST, which 7.0 has no stable JS API for. The forge restores
`.forge-cache/` from the base's own green check and keeps it only from green checks of the default
branch (`src/checks/cache.ts`), so a pull's code never fills a cache another
check reads. The full gate also writes every file's time there, and the next
split weighs every file by measurement rather than the 41 the table named.

The fast tier picks by measurement. The full gate runs each file in a
`bun test` of its own under Bun's coverage (`--impact`; coverage is per
process, so a shard of many files would blur theirs together) and writes
the impact map: test file → the `src/**` files whose functions it called.
A file merely imported — its top level run, none of its functions — does
not count; that is the import graph again (#1794). Under the forge the map
is handed over as `$FORGE_CHECK_IMPACT` in the checkout: every check is
seeded with the one the last green default-branch run kept (under
the forge's data directory, `checks/impact/`, `src/checks/impact-store.ts`), and
only such a run, or the full gate on land, keeps a new one. By hand it is
`scripts/test-impact.json`. A diff intersected with it is the set of tests
the change reaches; the plan line says `by coverage: N changed files reach
M tests; src/x.ts reaches none` (a coverage gap). A measured test is
guessed by imports only against the changes the map cannot see; tests the
map has never seen fall back to the import-hop guess, and a change to
`forge.json`, `package.json`, `scripts/**` or `src/kernel/**` runs
everything. With no map yet the line says `by imports (no impact map)`.

A test that reads the whole tree — every test file, every migration, the
README — is reached by no diff, yet any file can break it. Those are
`RULE_TESTS` in `src/checks/tiers.ts`, and every fast tier runs them
whatever else the diff holds (#7138) — a diff of only the timing or impact table breaks no rule and runs none; a new rule of that kind goes on the list. Write
the rule with `breaches()` from `test/helpers/rule.ts`: one red test per
breach, named `path:line: …`, so the check's summary names the rule and
the line.

Before you push, ask what the fast tier would run for your change:
`files=$(bun scripts/fast.ts) && bun test $files`. `bun scripts/fast.ts
[--base origin/main] [--why | --null | --json]` lists the picked test files
for the diff from the base's merge-base to the working tree (committed,
uncommitted, untracked), one per line on stdout and nothing else there;
`--why` adds a tab and the reason, `--null` ends each path with NUL (for
`xargs -0 -r bun test`), `--json` is `{full, files:[{file, why}]}`. Exit 0:
files listed. Exit 3: the change reaches no test (stdout empty). Exit 2: the
diff cannot be bounded (`forge.json`, `package.json`, `scripts/**`…, said on
stderr as `full tier: … changed`), or the arguments or git failed. The
`&&` is what keeps an empty or unbounded answer from becoming a bare
`bun test`, which would run the whole suite.

Files go to shards by how long they take, not how big they are: longest
first onto the least-loaded shard, weighed from `scripts/test-times.json`
(file → seconds, from one recorded run). A file the table does not name
weighs its bytes at the table's own seconds-per-byte. If the table is
malformed, the log says it was refused and the split falls back to bytes.
A stale table only makes the split less even; it never drops a file.
Refresh it with one command after adding a slow test file, or when the
log's slowest shard is well over 1.5× its fastest:

```sh
bun run check:record  # the gate's own command, with test-shards.ts --record
```

`--record` runs each file as its own `bun test`, with as many running at
once as the gate runs shards. It rewrites the table only when every file
is green. Files it did not run keep their old times.

Every file is independent (its own forge, its own database, port 0), so a test that fails only beside another is a bug
in that test. Two things it will not do:

- **It never borrows your git configuration.** A test drives a real `git`
  against a forge it booted a second ago, and builds that child's
  environment rather than inheriting yours (`test/helpers/git-client.ts`) —
  otherwise a `GIT_CONFIG_COUNT` in your shell (a crew run sets one, holding
  its own forge credential) would send that credential to the test's server
  and every push in the suite would come back `401`.
- **It skips what this machine cannot run, out loud.** The OpenSSH interop
  tests need `ssh` and `ssh-keygen`; without them the log says `SKIPPING:`
  and names the tool (`test/helpers/tools.ts`). Install OpenSSH and they run
  again — the skip is conditional on the binary, never on anything else.

Every `test/*.test.ts` is in the gate unless `EXCLUDED` names it with a
one-line reason and the issue that owns admitting it, so a new test file is
gated the moment it exists and no pull edits a shared list for it (#2037).
`test/check-list.test.ts` goes red on an exclusion named twice, without a
reason or issue, or for a file that does not exist. An excluded file rejoins
the gate by deleting its `EXCLUDED` entry in a pull whose check is green and
whose description carries ten green runs in random order under load:
`bun scripts/flake-hunt.ts admit test/x.test.ts` runs the file ten times, each
its own `bun test --randomize` with a fresh seed beside busy loops, prints the
record and exits non-zero unless all ten are green.

A brand-new test file does not need that record: it joins the gate on its
own green check, not ten runs. That is accepted on purpose — a flaky new
test can turn the gate red once before anyone sees it — and the nightly
flake hunt below is the backstop that files it and quarantines it. One
shape is refused on sight, new file or not, because ten runs on a fast box
miss it: a wait that runs out of time and carries on — a loop that polls a
condition at most N times or until a deadline, and whose next statement
neither checks the outcome nor returns it (`fallThroughWaits` in
`scripts/flake.ts`). `admit` refuses such a file before any run, naming the
line, and `test/flake.test.ts` refuses it in every test file except the 47
that held one when the rule began (`FALL_THROUGH_OWED`, owned by #9025; the
rule goes red on a listed file that no longer breaches, so the list only
shrinks). The fix is one line after the loop: fail saying what never came.

### How tui-backups and conversation-queue got in (#9017)

Neither passed an admission run; neither was ever given one. Both were new
files, so each joined the gate on its pull's own green check: no seed (the
gate runs every file's tests in written order, without `--randomize`), the
check cell's own load, one run.

- `test/tui-backups.test.ts` joined with #7278 (6e48d8c0). Its tests read
  the destination an earlier test sealed, and its key check read the frames
  every earlier test drew, so it was green only in written order. Run
  through `admit` as it landed, it is red in 9 of 10 runs (seeds 2899264984
  … 2895068531, the one green seed 3988233074); as #8995 left it, 0 of 10,
  and refused first for its prompt wait. #9017 made each test make its own
  destination and check every frame as it is drawn: 10 of 10 green.
- `test/conversation-queue.test.ts` joined with #8893 (65654ceb). Its
  `until` polled 200 × 20 ms and then went on as if the condition had
  come, so on a slow box the test stopped a turn before the forge had read
  its partial answer. Under `admit` as it landed it was red once in 10
  (seed 795951491), so one admission run could have passed it; it is now
  refused before any run, at its line 48. As #8995 left it, it passes:
  10 of 10 green.

**No flaky tests.** Nightly at 02:17 UTC the forge itself (`src/nightly/`,
a cell on a checkout of main) runs every gate file five times on a loaded box, each run a fresh seed that orders both
the files and (through `--randomize`) the tests inside them, nothing stopped
early. A file red in some runs and green in others is flaky: the hunt files
a `Flaky: test/x.test.ts` issue carrying the failure text, the seed and the
run, with the usual root causes to tick (a shared port, a real clock, order
dependence, a leaked server, a timeout set near the real duration, a tight
wall-clock bound); then
`bun scripts/flake-hunt.ts quarantine` moves every file an open `Flaky:`
issue the hunt itself filed (its author is the token's user and the forge
has not marked it untrusted) into `EXCLUDED` under that issue and proposes
the move as a pull; a file the issue names that no longer exists is skipped,
since its exclusion would turn the audit red. Nobody hand-edits the list. A file red in every run is broken,
not flaky, and the check already says so. The fix is the test's shape, never
a retry: `test/flake.test.ts` fails on `--retry`, `--rerun-each`, a bunfig
`retry` or a `{ retry: N }` anywhere the gate runs, and on any test that
bounds a measured time under 200 ms (a loopback fetch on a loaded runner
takes tens of ms): assert relative to a baseline from the same run, or bound
only the failure the test names. The hunt takes the gate in
20 slices, one after another, each cut at 30 minutes, and ends by proposing the
quarantine as a pull on `flake-hunt/<date>`. Worst case, all 20 slices hit
their cut: 20 x 30 minutes, plus the install and the quarantine (10 each), so
about 10 h 20 min, ending near 12:40 UTC. Jobs run one at a time, so the
outside run (03:47) queues behind a long hunt and starts late; it still keeps
its own slot, which is what the record and the owed-on-waking rule read. A
stop (a release) aborts the running step at once. The forge needs `FORGE_TOKEN` (the
hunt's author) and cells; a preview runs none, and a forge without either says
so in its log and runs none. A job whose slot passed while the forge was down
runs on waking; one restarted mid-run is not run twice (`nightly/<job>.json`
in `FORGE_APP_DATA`). What each last did, and what it filed (`filed #12`,
`closed #4`, `quarantined test/x.test.ts`), is on Resilience and in the
terminal's Resilience dialog; the run's whole output is
`/resilience/nightly/<job>` (`nightly/<job>.log`), the run every issue it
files names, as the Forgejo jobs named their Actions run
(`docs/features/nightly.md`).

**No unseen red outside the gate.** Nightly at 03:47 UTC, the forge itself
runs `bun scripts/flake-hunt.ts outside --file-issues`: every file in
`EXCLUDED` (the complement of the gate, from the same list, so a file moved
into the gate is no longer run there), once, one at a time, with the gate's
60 s timeout. A file that newly fails opens one `Red: test/x.test.ts` issue
naming its first failing test; still red on another test, it updates that
issue; still red on the same test, it says nothing, so the owner's asks show
it once; passing again, it closes the issue. Same `FORGE_TOKEN` as the hunt.

The Forgejo workflows these replace, and `sync-env`, are covered in
`docs/features/nightly.md`.

Bun's own `--randomize --seed=N` drives every hunt and admission run. Not
used: `--rerun-each` (one seed for every rerun, so ten reruns explore one
order) and `--parallel` (it changes the load the gate is judged under).

The gate also refuses hollow work. `test/hollow.test.ts` runs
`scripts/hollow.ts`, which names an exported function in `src/actions/` that
nothing that runs reaches — no route's handler, MCP tool, crew worker, CLI
command or terminal screen, followed from where the program starts — and a
screen — a GET path with no parameter that draws a page — that no reachable
page links to. `scripts/hollow-allow.ts` lists what main
carries today, each entry under the issue that owns it; an entry that is no
longer hollow turns the check red, so the list only shrinks.
`bun scripts/hollow.ts` prints the same lines on their own.


## Shards

Each shard gets its own
`TMPDIR` and `FORGE_APP_DATA` (nested under the cell's, when it set one),
removed when the shard ends.
