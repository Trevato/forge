# Machines (#9418, first slice)

A machine is a named configuration a crew member's shell runs in: the tools
its role is given, what it may use up, and how far it may reach.
`src/crew/machines.ts` holds the catalog and the validation;
`src/crew/machines_read.ts` reads a repository's choice.

## Configure

At the top level of `forge.json`, read at the **default branch's tip** (a run
cannot widen its own machine by editing the file on its branch):

```json
"machines": { "audit": { "tools": ["gitleaks", "trivy"], "reach": [] } },
"machineFor": { "reviewer": "audit" }
```

- `tools` are picked from a list (`TOOLS`): gitleaks, trivy, osv-scanner,
  nuclei, zap, testssl.sh, nmap. A name is never a command.
- `reach` is `["apps"]` (the repository's own production and previews, as
  today) or `[]`. A machine cannot name a host, so it can only narrow the
  sandbox; the forge's secrets stay denied by `crew/sandbox.ts` whatever a
  machine says.
- `machineFor` maps a crew role (planner, builder, reviewer) to a machine. A
  role with none runs in `standard`, which is today's sandbox exactly.
- `standard` and `security` are built in. `security` carries the investigation
  tools, aimed at the forge's own copies only.
- `memory` (whole MiB, 256–65536) and `cpus` (cores, 0.25–64) are the run's
  ceilings, e.g. `"audit": { "memory": 2048, "cpus": 2 }`. They only narrow:
  `cpus` is never above the forge's own `FORGE_CREW_CPUS`, and a machine that
  sets neither (`standard`, `security`) runs exactly as today, uncapped in
  memory. The kernel holds them in the run's cgroup cell
  (`src/crew/run-cell.ts`, `src/apps/cgroup.ts`): past `memory` the run is
  OOM-killed, never the forge. A run with a memory cap enters its cell
  strictly, so it never runs uncapped in a cgroup made for it.
- Where the host cannot hold a ceiling (no delegated cgroup v2, no cpu
  controller), the run's log says so in one line, e.g.
  `machine: memory 2048 MiB not applied: no cgroup v2 here`; where it can,
  `machine: held to memory 2048 MiB and 2 CPUs`.
- An invalid declaration falls back to `standard`; it never stops the crew.

## What a run gets

`FORGE_MACHINE` and `FORGE_MACHINE_TOOLS` (names only) in its environment, a
line in its brief naming the tools its machine carries, and its `apps` reach.

## Not done yet (split from #9418)

Disk ceilings are not declared (#9460); the tools are declared, not yet installed in an image; the browser
shell (ghostty-web, tmux, WebSocket, session records) is not started.
