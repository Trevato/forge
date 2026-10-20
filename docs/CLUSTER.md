# Turning the check lane on in a cluster

By default a check runs in a cell on the forge's own machine. With
`FORGE_CHECKS_PLACEMENT=job` it runs as a Kubernetes Job instead
(`src/cluster/jobs.ts`). This page is exactly what an operator applies; the
chart is the owner's and is not described here. A test
(`test/cluster-doc.test.ts`) fails if this page drifts from the code.

## Role

The forge talks to the API server with its pod's service-account token, in
that pod's own namespace. It needs one Role in that namespace, bound to that
service account:

| apiGroup | resource    | verbs    | why                                                        |
| -------- | ----------- | -------- | ---------------------------------------------------------- |
| `batch`  | `jobs`      | `create` | `POST /apis/batch/v1/namespaces/<ns>/jobs` starts a check  |
| `batch`  | `jobs`      | `get`    | polled until `succeeded` or `failed`; a 404 means it vanished |
| `batch`  | `jobs`      | `delete` | the Job is removed when the run ends (`propagationPolicy=Background`) |
| `""`     | `pods`      | `list`   | finds the Job's pod by `job-name=<job>`, for its exit code and node |
| `""`     | `pods/log`  | `get`    | reads the pod's log into the run's log                     |

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: forge-checks }
rules:
  - apiGroups: ["batch"]
    resources: ["jobs"]
    verbs: ["create", "get", "delete"]
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["list"]
  - apiGroups: [""]
    resources: ["pods/log"]
    verbs: ["get"]
```

Nothing else is used: no `watch`, no `update`, no cluster-wide verbs.

## Environment

Read once at boot by `src/checks/placement.ts`. A malformed value leaves
`process` in place; nothing is guessed.

| variable                     | example                                | meaning |
| ---------------------------- | -------------------------------------- | ------- |
| `FORGE_CHECKS_PLACEMENT`     | `job`                                  | `process` (default) or `job` |
| `FORGE_CHECKS_IMAGE`         | `registry.example/forge-check:1`       | the Job's image; required, no whitespace |
| `FORGE_CHECKS_CLAIM`         | `forge-checks`                         | a ReadWriteMany claim holding the checks root; required |
| `FORGE_CHECKS_NODE_SELECTOR` | `pool=checks,disk=ssd`                 | `key=value,key=value`; optional |
| `FORGE_CHECKS_TOLERATIONS`   | `[{"key":"dedicated","operator":"Equal","value":"checks","effect":"NoSchedule"}]` | JSON list, at most 20; optional |

## Only while egress is reported

The lane applies only while `cells.egress` is `report`. Under `enforce` (the
default) a Job cannot hold egress, so every check stays in a cell: the run
records `placement: process` and its log says
`placement: job skipped, egress is enforced and a Job cannot hold it`. The
setting is read on every run, so an admin's change takes effect on the next
check.

## Label for a NetworkPolicy

The forge does not enforce egress on a Job. Every check pod carries the label
`forge-check: "true"` (`JOB_LABELS` in `src/checks/job_step.ts`), so a
NetworkPolicy can select it and hold what a check declares:

```yaml
podSelector:
  matchLabels: { forge-check: "true" }
```

## Confirming the lane is on

1. Push to a pull, or re-run its check.
2. With `cells.egress` at `report`, the run's page says "ran as a cluster job on <node>"; a `process` run says
   nothing.
3. In the cluster, `kubectl get jobs,pods -l forge-check=true` shows the Job
   while it runs (it is deleted when the run ends).
4. If every run still says nothing, a variable above is missing or malformed:
   the forge fell back to `process`.
