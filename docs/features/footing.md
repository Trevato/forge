# What the forge stands on (#11685)

The pieces the forge needs to answer a request, sign a person in, build,
release and back up, and the machine each one runs on. Any piece that is not
on the forge's own machine is a way that machine can take the forge down. The
declared list is the table in [`docs/OPERATING.md`](../OPERATING.md#what-the-forge-stands-on);
the three doors below read it against the live cluster.

All three are for a forge admin who is a person (the MCP tool: a forge admin).
None of them waits on the cluster: they show the last reading, held 60 s, and
the declared list while the first one runs.

## On /system

Under **What the forge stands on**, the summary says how many pieces run on
another machine. Open it to see:

- where the forge runs (its pod's node), or why that was not read;
- each piece on another machine, in the order switching pg-grand off would
  break the forge, with what it is needed for, where it runs, what happens if
  that machine stops, its place in that order, and the issues that remove it;
- the pieces on the forge's own machine, by name;
- what each machine is.

"Runs on" is a node name when the cluster showed the piece's pod there. It
reads `pg-grand (declared: …)` when the cluster could not show it, with the
reason: a systemd unit on a host, a CronJob with no pod between runs, a
namespace the service account may not list, or a pod whose namespace is not
recorded. A declared piece is judged by its declared machine.

## In the terminal

Open the palette and choose **What the forge stands on** (it follows
**Main-thread stalls**). The screen lists the same rows as the page: the
forge's node, then each piece on another machine in break order with its
step, need, machine and what happens if it dies, then the steps themselves and
the pieces on the forge's own machine. `j`/`k` scroll, `esc` closes.

## Over MCP

```json
{ "name": "system", "arguments": { "kind": "footing" } }
```

answers `forgeNode`, `unread` (why the forge's node was not read, or null),
`at`, and per piece `{ id, need, what, machine, seen, risk, ifDies, issues,
breaks }`. `seen` is `{ by: "cluster", nodes }` when the cluster showed it and
`{ by: "declared", why }` otherwise; `risk` is true when the piece is not on
the forge's machine. `risks` repeats those pieces as one line each, in break
order. Anyone but a forge admin is refused.

## Keeping it true

The list is `FOOTING` in `src/system/footing.ts`; `test/footing.test.ts` holds
the OPERATING.md table equal to `footingTable()`. Change the list there, then
paste the output of
`bun -e 'import {footingTable} from "./src/system/footing.ts"; console.log(footingTable())'`
between the markers in OPERATING.md.
