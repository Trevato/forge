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
`/readyz` says 200 and leaves when it does not, probed every 5 s as the
chart probes. Once the new forge is in, the old one is sent SIGTERM. A minute
later it prints its verdict and exits:

| exit | means                                                          |
| ---- | -------------------------------------------------------------- |
| 0    | zero refused: roll                                             |
| 1    | a request got a 5xx or no answer, or nothing rolled: do not roll |
| 2    | an argument is wrong, or a forge would not start               |

Exit 1 is a bug in the release, not a reason to ask for a dark roll: the
logs it names say which forge refused and when. Release checklist: step 1
exits 0, then this exits 0, then roll. Quote the `zero refused` line in the
release notes.

The old forge keeps its listener open for `FORGE_DRAIN_LINGER_S` (10 s)
after SIGTERM, because routers learn it left rotation a probe period after
it did. With `--linger 0` the rehearsal shows what that costs: every
request routed to it in that beat is refused.

## 4. Roll

Release as the release workflow does. Nothing in this recipe changes the
workflow or the chart.
