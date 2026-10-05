# Fleet operations

One action over every row a query selects, with the plan shown before
anything changes and a receipt kept after.

```sh
# the plan: every row, before → after, and the rows refused with the reason
curl -sX POST $FORGE/api/v1/fleet/ops -H "authorization: Bearer $TOKEN" \
  -d '{"query":"repo autonomy:autonomous","action":{"verb":"autonomy","value":"off"}}'

# the same, applied (an admin token): the receipt comes back
curl -sX POST $FORGE/api/v1/fleet/ops -H "authorization: Bearer $ADMIN" \
  -d '{"query":"repo autonomy:autonomous","action":{"verb":"autonomy","value":"off"},"dryRun":false}'

# undo it, once
curl -sX POST $FORGE/api/v1/fleet/ops/$ID/undo -H "authorization: Bearer $ADMIN"
```

## The query

A kind — `repo`, `run` or `issue` — then `field:value` terms, all of which
must hold. `!` before a value negates it. `repo:owner/name` (or a bare name)
works on every kind.

| kind  | fields                                                      |
| ----- | ----------------------------------------------------------- |
| repo  | `repo` `owner` `name` `id` `autonomy` `visibility`          |
| run   | `repo` `owner` `name` `id` `state` `kind` `agent` `issue`   |
| issue | `repo` `owner` `name` `id` `number` `state` `assignee` (`none`) `label` `limb` |

`limb:<number>` selects a limb: the issue of that number and everything
beneath it that only it needs, top down, and never what something outside
the limb also waits for. It needs `repo:owner/name`.

Only rows you can read are selected. More than 500 rows is refused
(`too_many`), never cut. This grammar is `src/fleet/selection.ts`; the fleet
table (#446) grows it.

## The actions

`action` is `{ "verb": …, "value": … }`, or a bare verb when it takes no value.

| kind  | verb        | value                     | undo |
| ----- | ----------- | ------------------------- | ---- |
| repo  | `autonomy`  | `off` `assisted` `autonomous` | yes |
| repo  | `slots`     | 1–8                       | yes  |
| repo  | `ceiling`   | dollars, 0–10000          | yes  |
| repo  | `direction` | text, ≤ 2000              | yes  |
| run   | `cancel`    | —                         | no   |
| run   | `requeue`   | — (a cancelled or failed agent run) | no |
| issue | `close`     | —                         | yes  |
| issue | `assign`    | a username, or `none`     | yes  |
| issue | `label`     | a label's name (added)    | yes  |
| issue | `link`      | the number they wait for  | yes  |
| issue | `file`      | `later`, a pillar, or `none` | yes |
| issue | `drop`      | the reason, one sentence  | yes  |

## Who may

Every row needs admin of its repository; the rest come back `refused` with
the reason, in the plan and in the receipt. A dry run takes a read token;
applying and undoing take an admin one. An agent may preview but never
apply. Each row is written through the same action a person's click calls,
so it is authorized again and leaves its own event.

## The receipt

Applying records a `fleet_operation` row (who, the query, the action) and
one row per selected target: the value before, the value asked for, and
`ok`, `failed`, `refused` or `unchanged` with the reason. One
`fleet.operated` event — for its actor alone, since it names repositories
across the forge — carries the counts. `GET /api/v1/fleet/ops` lists your
operations; `GET /api/v1/fleet/ops/:id` is one receipt.

Undo is a new operation that writes each `ok` row's value from before,
only where the row still holds what the operation left; a row someone
changed since is refused as `changed since: it is … now`. It writes the
rows backwards, so what was done last is undone first.

`file` says where an issue stands in the plan: `later` puts it behind the
Later gate and under the Later umbrella, out from under any pillar; a
pillar's name or short form puts it under that pillar and out from behind
the gate; `none` takes it out of both. `drop` closes an issue as dropped
and says the reason on it; its undo opens it again. The actions on a whole
limb (`docs/PLANNING.md`) are these two verbs over a limb.
