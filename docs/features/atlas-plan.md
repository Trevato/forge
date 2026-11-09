# A business, as a map (#439)

Atlas answers a business described in words with a plan, not code: one
value, `{ description, apps: [{ slug, purpose }], adapters: [{ system, data }],
edges: [{ from, waitsFor }] }`, an app per capability and an adapter per
external system, an edge naming an app slug or an adapter system on each
side. It is checked once (`src/actions/business_plan.ts`) and reached by three
doors that share that path: the API, the terminal and MCP.

## The API

`POST /api/v1/repos/:owner/:name/atlas` with `{ "plan": …, "pillar"?: … }`
(`rw` scope) answers a dry run: the issues it would open, their links, its
`stamp`, and the `spawn` seed (`direction` and `fresh` for a spawn plan,
docs/SPAWN.md), so the same map can ship as its own forge. Nothing opens
until `"confirm": true`:

- `201 { status: "opened", opened, ready }`: opened through `openPlan`, all or nothing.
- `202 { status: "proposed", id }`: where plans need a nod, kept as a proposal.
- `200 { status: "already", numbers }` or `{ status: "already-proposed", id }`:
  this plan was confirmed here before; nothing more is opened or proposed.
- `403` for someone who may read but not write; `404` for someone who may not read.

## The terminal

In a repository, the palette's **Atlas plan** (offered to writers and the
crew, as the API's confirm decides) takes the same JSON body, pasted over
the template. `ctrl+d` shows the issues it would open; `ctrl+d` again on the
same plan opens them through the same confirm, so web viewers see them live
as they do from the API. Any edit to the plan previews again.

## MCP

The `atlas` tool takes `{ app, plan, pillar?, confirm? }` and answers as the
API does: a dry run, then `opened`, `proposed`, `already` or
`already-proposed`.

## What is refused

With 422 and nothing opened: a description that is not text, empty, holds
control characters or is over 4000 characters; more than 12 apps and
adapters together; a slug that is not 1-39 of `a-z0-9-`; a name used twice;
an edge naming something not in the plan; an edge loop; a `pillar` that is
not one of the repository's pillars (`unknown_pillar`). A body over 64 KiB,
counted as it is read (chunked or not), is 413 `too_large`.

## Opening once

Every issue it opens ends with the line `Atlas plan \`<stamp>\``, the hash
of the plan's canonical form; a later confirm looks only for issues whose
body ends with that line (an issue quoting it elsewhere does not count), and
for pending proposals of the same plan. The look and the opening run in one
write transaction, so two confirms at once open the plan once. No issue is
assigned: a person picks who builds what.
