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

What happens after an exit 3 is #1589's step. Until that lands, do not roll:
put the printed answer in front of the owner.

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

## 2. Roll

Release as the release workflow does. Nothing in this recipe changes the
workflow or the chart.
