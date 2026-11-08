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
line in its brief, and its `apps` reach. Both report what is **installed**, not
what is declared (#9506): `FORGE_MACHINE_TOOLS` lists only the machine's tools
found on the forge's PATH (`Bun.which`, PATH only: nothing is downloaded or
run), and the brief names those with what each is for, then lists the rest as
"not installed on this forge". A machine with none of its tools on PATH gets
one line saying so. Installing the tools is a separate step, not done yet.

## A shell into a machine (#9471)

`src/machines/shell.ts`. A WebSocket at
`/<owner>/<repo>/machines/<machine>/shell` opens a shell into one of the
repository's machines:

- **Who.** A signed-in person (a session cookie or the platform edge, never a
  token) with write permission on the repository, from this forge's own
  pages: the `Origin` must be the forge's, and a missing one is refused. A
  reader is refused 403 on a public repository; a private one, or a machine
  it does not declare, answers 404.
- **Where.** tmux (or `/bin/sh` where tmux is not installed) on a real pty,
  in a cell (`apps/contain.ts`) under the machine's memory and CPU ceilings,
  with the forge's data hidden and no reach beyond the forge. Each writer has
  a directory and home of their own on each machine,
  `<data>/machines/<repo id>/<machine>/<user id>`: one writer's files and
  shell history are never the next's. A forge that cannot hold a cell closes
  the socket (1011, "this forge cannot hold a machine's shell") rather than
  hand out a shell on its host. The command is a constant: nothing a person
  sends reaches a command line. A shell that fails to start leaves no pty,
  cell or open row behind (its row ends `failed`).
- **Frames.** Binary frames are keystrokes in (at most 64 KiB each; a bigger
  one closes with 1009) and screen bytes out; a peer that stops reading
  (over 1 MiB waiting) is closed. A text frame is
  `{"type":"resize","cols":n,"rows":n}` (cols 1–500, rows 1–300); any other
  text frame closes the connection (1003).
- **Limits.** 16 sessions on the forge at once and 3 per person; 20
  handshakes per person a minute. Past either the handshake answers 429.
- **One session per person, repository and machine.** A second connection
  (another tab, a reload) joins the running session and sees the same
  output. The session ends when the shell exits, after 30 minutes with no
  keystroke, or — checked every 5 seconds and when its last connection
  closes — once its owner is suspended or can no longer write here.
- **Records.** Each session is a row in `machine_sessions` (machine, owner,
  start, end and why: `exit`, `idle`, `stopped`, `revoked`, `failed`). No
  shell outlives its forge, so a row a stop or crash left open is closed as
  `stopped` when the forge boots. Writers see the last 20 at
  `/<owner>/<repo>/settings/machines` (in the settings frame for an admin,
  on its own for a writer who is not one), and in the terminal: the palette's
  **Machines of a repository** (`src/tui/screens/machines.ts`), writers only.

## Not done yet (split from #9418)

Disk ceilings are not declared (#9460); the tools are declared, not yet
installed in an image (the brief reports which are on PATH); the browser terminal (ghostty-web) that speaks to the
shell socket is not built; the shell's cell does not reach the repository's
apps even when its machine says `apps`.
