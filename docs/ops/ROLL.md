# The roll recipe

How the forge's own release rolls onto the platform, and the step that comes
before it every time (#1588, part of #873).

The chart rolls with `maxSurge: 1, maxUnavailable: 0`
(`charts/app/templates/deployment.yaml`). The new pod comes up beside the old
one, and the old one drains only once the new one is ready. The volume is
local-path, which binds it to one node, so the new pod has to fit on **that
node**, next to the old one. If it does not, the roll cannot be zero-downtime.

## 1. Before rolling: can a surge pod schedule?

The forge runs in namespace `$NS` as the Helm release `$REL`. The Deployment
and its `app` label carry that name.

```sh
POD=$(kubectl -n "$NS" get pod -l app="$REL" -o jsonpath='{.items[0].metadata.name}')
NODE=$(kubectl -n "$NS" get pod "$POD" -o jsonpath='{.spec.nodeName}')
kubectl get node "$NODE" -o json > node.json
kubectl get pods -A -o json --field-selector spec.nodeName="$NODE" > pods.json
# The forge's steady memory: the MEMORY column, read over a quiet minute
# (no crew run starting). Not a peak, and not a cold start.
kubectl -n "$NS" top pod "$POD" --no-headers

bun scripts/roll-preflight.ts --node node.json --pods pods.json \
  --pod "$NS/$POD" --steady 3712Mi
```

It prints its answer and exits:

| exit | means                                                                |
| ---- | -------------------------------------------------------------------- |
| 0    | a surge pod fits: the roll is zero-downtime, go to step 2            |
| 3    | it does not fit: the output's `short by` line is the headroom it lacks |
| 2    | an input is not what `kubectl` prints; nothing was judged             |

`--json` prints the same answer as data.

Exit 3 means do not roll. The output says the seconds the roll would be
dark (`--dark-seconds`, from the last roll's gap between the old pod going
and the new one ready) and the headroom that would avoid it. Step 2 says what
may follow.

### The rule

`scripts/roll.ts` applies it. It counts whole millicores and whole bytes, as
the scheduler does.

| quantity | is                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------- |
| free     | node `status.allocatable` − the requests of every pod on the node that has not Succeeded or Failed  |
| need     | cpu: the forge pod's request. Memory: the larger of its request and its steady memory               |
| fits     | free ≥ need, for cpu and for memory                                                                 |
| short by | need − free, never below zero: the headroom that would make the roll zero-downtime                  |

A pod's request is counted the way the scheduler reckons it:

- containers and sidecars (init containers with `restartPolicy: Always`) are summed;
- each plain init container, together with the sidecars started before it, is a floor;
- the runtime class's overhead is added on top.

Steady memory is part of `need` because the request is only a floor. A pod
that requests 2 Gi but holds 3.6 Gi once warm schedules on 2 Gi free. Then
the two pods together hold more memory than the node has. The answer says
when this is the case: "the pod would schedule, but both pods' steady memory
would not".

### Worked example

On an 8 GB node with 3900m cpu and 7680 Mi allocatable, 3100m cpu and
5760 Mi are requested, which leaves 800m and 1920 Mi free. The forge requests
1000m cpu and 2048 Mi, and its steady memory is 3712 Mi. So it needs 1000m
and 3712 Mi, and is short by 200m cpu and 1792 Mi. `test/roll.test.ts`
carries this case.

## 2. A roll that cannot surge needs the owner's yes

Release checklist, in order:

1. Run step 1 with `--version <the version> --yes-file docs/ops/dark-rolls.log`.
2. Exit 0 and "zero-downtime": rehearse it (step 3), then roll.
3. Exit 3: **do not roll.** Tell the owner the seconds dark and the headroom
   short, and wait for an explicit yes to **that version**. Free the headroom
   instead if you can, and run step 1 again.
4. A yes is for one roll, named by version: `0.7.104`, not "the next one", not
   "any". A yes for another version does not count, and there is no standing
   yes. The chart never carries `maxSurge: 0` to make the check pass.
5. Record it beside the version, one line in `docs/ops/dark-rolls.log`:
   `0.7.104 yes <owner> 2026-10-15`. Run step 1 again; it now exits 0 and
   prints "dark roll of 0.7.104 allowed".

Without the line, no dark roll. The agent writes the line only after the
owner's yes is in the conversation, and quotes it in the release notes.

## 3. Rehearse the roll on a copy

A surge pod that fits is half of zero-downtime. The other half is the two
forges themselves: the new one migrating and serving beside the old one on
one data directory, and the old one draining without refusing anyone. The
rehearsal rolls a copy exactly that way, with requests running the whole
time, and counts every request a person would have seen refused.

```sh
git worktree add "$TMPDIR/forge-old" v<the running version>
bun scripts/rehearse-roll.ts --old "$TMPDIR/forge-old" --new . \
  --from <a restored snapshot's data directory>
```

It starts the old forge on a copy of `--from` (never the live data
directory: restore a snapshot first, `docs/RESTORE.md`), sends requests to
`/`, `/healthz` and `/explore`, starts the new forge beside it on the same
copy, and moves rotation the way the Service does: a forge joins when its
`/readyz` says 200 and leaves when it says 503 or nothing is listening,
probed every 5 s as the chart probes. A probe that only times out is a busy
machine, not a forge going away: like the chart's (Kubernetes' default
failure threshold), it takes three in a row to leave. Once the new forge is
in, the old one is sent SIGTERM. A minute later it prints its verdict and
exits:

| exit | means                                                          |
| ---- | -------------------------------------------------------------- |
| 0    | zero refused: roll                                             |
| 1    | a request got a 5xx or a refused connection, or nothing rolled: do not roll |
| 2    | an argument is wrong, or a forge would not start               |

Exit 1 is a bug in the release, not a reason to ask for a dark roll: each
`miss` line says when, which forge was asked, what came back (the client's
error code with it), and whether each process was serving, draining or gone;
the logs it names say the rest. A request the client gave up on is counted
`slow` and listed, but is not a refusal: the forge held its connection. Release checklist: step 1
exits 0, then this exits 0, then roll. Quote the `zero refused` line in the
release notes.

The old forge keeps its listener open for `FORGE_DRAIN_LINGER_S` (10 s)
after SIGTERM, because routers learn it left rotation a probe period after
it did. With `--linger 0` the rehearsal shows what that costs: every
request routed to it in that beat is refused.

## 4. Roll

Release as the release workflow does. Nothing in this recipe changes the
workflow or the chart.

**Cutting a release moves no branch (#6642).** On the commit of main being
released, `bun scripts/cut-release.ts <version> --tag` makes the annotated
tag `v<version>` whose message is the release record (`{"version",
"migrations", "ids"}`); push that tag to the forge's own repository, where
`release/shipped.ts` reads it for `/releases.json`, the children's standings
and the behind watch, and to the mirror, where it starts `release.yml`.
Nothing is committed: a commit to main would void every gate in flight
(#6640). `src/core/releases-before-tags.json` keeps the releases cut before
this, frozen.

## Gates in flight across a roll (#6722)

A roll does not turn a merge-queue gate red. On SIGTERM the old forge
starts no new gate and gives the gates under way `FORGE_CHECKS_DRAIN_S`
(10 s) to finish, the crew's runs `FORGE_CREW_DRAIN_S` (10 s); what is left
is handed back queued. The old forge stops writing within seconds, so the
new forge's `waitForPeer` (`src/runs/peer.ts`) returns at once and the
release's write pause stays under 30 s (#7799). Before that the drain was
660 s and the pause as long. Both budgets are read in `src/drain.ts`; junk
falls back to 10 s.

A gate cut off at the drain is `interrupted`, never red, and the new forge
gates the same candidate again from the persisted queue
(`test/merge-queue-restart.test.ts`: "the run gone, the same candidate is
gated again" and the #6722 red case). A gate that outlives the drain on a
roll is therefore redone, not lost; set `FORGE_CHECKS_DRAIN_S` higher to
trade a longer write pause for fewer redone gates.

If a crew run ignores the abort at the end of its 10 s, the old forge's
leases stay renewed and the new forge logs "another forge still works this
database" and keeps serving pages but holds its queue work. It starts when
the run's process finally ends, or after `PEER_WAIT_MAX_MS` (720 s, the
pod's grace, after which the platform has stopped the old pod). Pages answer
throughout; only queue work is late.

What the drain does not finish is no verdict, never red:

- a gate cut off at the drain's end, or one whose check a signal from
  outside ended (the pod going, the kernel's OOM killer, exit 137 or 143),
  is `interrupted`: no red batch, no suspect, and the new pod gates the same
  candidate again (`src/checks/queue.ts`, #6611);
- a gate that came back `red (check)` — red with no test and no type error
  named — is gated once more before the queue bisects it, as an install red
  is. Red again, it is searched as the code's.

## The gate of record (#2794)

A release ships on two proofs, and nothing else holds it:

1. **The forge's own full check, green on the release commit.** The check
   every push to `main` runs (`forge.json` `check.run`, never a pull's fast
   tier), read from the forge by full commit id:
   `GET /api/v1/repos/:owner/:name/commits/:oid/check` answers
   `{commit, state, runId, summary, finishedAt}`, where `state` is `ok`,
   `failed`, `pending` (queued or running), `superseded` or `none` (main
   never checked it). The newest of main's own checks of that commit
   decides; a cancelled one is passed over when another check of the commit
   stands (a restart queues it again), and is `superseded` when none does:
   main moved on while it waited, and nothing will check that commit again.
   Main moving does not hold a release (#3966): when the commit's own check
   is `superseded` or `none`, the newest of main's checks of a later commit
   that contains it (`git merge-base --is-ancestor`) answers instead — `ok`
   when green, `pending` while running — since that full check ran the
   tagged tree plus what landed after. A red later check is no verdict on
   the tag and is passed over. `checkedCommit` names whose check answered.
   `release.yml`'s first gated step polls it every 30 s for up to two hours
   and builds only on `ok`; `failed` stops the release with the run's link,
   `superseded` stops it at once, and `none` stops it after ten minutes (a
   push to main queues its check at once). Tag a commit main has checked. It reads the mirror's variable
   `FORGE_URL` and secret `FORGE_TOKEN`, the two the flake hunt already
   needs.
2. **The built image boots.** The Dockerfile runs `bun src/release/boot.ts`
   on the image it just built (below); a refusal fails the build and nothing
   is pushed.

An image in the registry has therefore passed both. The mirror runs no copy
of the suite on a push, a pull or a tag: its `check.yml` held 0.7.170–0.7.173
on reds only that runner saw and caught none of the failures that reached
production, so it is gone (`test/release-gate.test.ts` keeps it gone). The
nightly `flake-hunt.yml` and `outside-gate.yml` stay: they file issues, they
gate nothing.

After the roll, a version not ready in `FORGE_READY_GRACE_S` is rolled back
to the last good one by the launcher, with no one asked (below). Until the
forge deploys itself (#1432), this is how a release ships.

## A release that does not boot (#2652)

Three guards stand between a release that cannot start and production, all
in `src/release/`:

- **At build.** The Dockerfile runs `bun src/release/boot.ts` on the image it
  just built: `src/main.ts` on an empty data directory must answer
  `/api/v1/health` as `$VERSION` within two minutes, or the build fails and
  nothing is pushed. The image ships `src/` alone; `test/src-imports.test.ts`
  refuses any import from `scripts/` or `test/`.
- **Before the roll.** The chart's pre-upgrade hook
  (`charts/app/templates/boot-proof.yaml`) runs the new image's
  `boot.ts --from /data` beside the running forge, on a copy of its database
  and top-level files. A refusal fails the upgrade while the old pod serves;
  the failed Job is kept for its log (`kubectl -n "$NS" logs job/$REL-boot-proof`).
- **After the roll.** The image starts `src/release/launch.ts`, which runs
  `src/main.ts` and, when that version exits or is not ready within
  `FORGE_READY_GRACE_S` (150 s, inside the startup probe), starts the last
  version that was ready, kept on the volume under `release/good/`. The forge
  that comes up shows a `release:rolled-back` card and pages the admins once.
  The next version that reads ready clears it.

## A forge beside one still draining (#6957)

bun:sqlite waits for the write lock on the one thread the forge serves from,
up to `busy_timeout` (15 s) a statement. 0.7.278 booted while 0.7.276 still
ran its gates and crew runs on the same database. It started its own work
beside them, and `/healthz` timed out for minutes behind the old pod's writes.
Three things keep that from happening again:

- **The new forge holds its work** (`src/runs/peer.ts`). Its listener
  answers at once. Its checks, merge queue, crew and ticks start only once
  no running run that another process holds has renewed its lease within
  30 s, or after 720 s (the pod's grace). The log says
  `another forge still works this database` when the wait starts and
  `the other forge let go of this database` when it ends.
- **Telemetry never waits on the lock** (`withoutWaiting` in
  `src/kernel/db.ts`). Route timings, usage counts and machine samples try
  the lock once, keep their rows and try again on the next flush. Every
  probe is counted, so without this a probe's own count would hold the next
  probe up.
- **The next stall names itself.** `event loop stalled lateMs=…` is a
  warning whenever the loop wakes more than a second late
  (`src/kernel/loop_lag.ts`, on from the first line of the boot). `slow
  statement held the thread ms=… sql=… stack=…` names any statement on the
  forge's handle that took 200 ms or more, with its callers
  (`src/kernel/slow_sql.ts`), at most ten lines a minute.

`test/boot-beside-peer.test.ts` boots `src/main.ts` beside a process that
holds the write lock 2.5 s of every 2.65 s and keeps a batch of 8 check
leases fresh. Every `/healthz` probe must answer within a second, and the
forge's work must start once that process lets go.
