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
  with the forge's data hidden. It reaches the forge and, when the machine
  says `apps` (as `standard` does), the repository's own production and each
  open pull's preview, each at its exact host and port through the cell's
  egress proxy (`shellReach`, #9934); a machine with `reach: []` reaches the
  forge alone. Another repository's app and every other host stay refused,
  and nothing a machine says un-hides the forge's data. Each writer has
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
- **Idle.** A shell with no keystroke and no output for the admin limit
  `shell_idle_minutes` (default 30, 5 to 1440, set at `/admin/limits`, read at
  every check) ends as `idle`; one that prints, like a build, is never idle.
- **Records.** Each session is a row in `machine_sessions` (machine, owner,
  start, end and why: `exit`, `idle`, `stopped`, `revoked`, `failed`). No
  shell outlives its forge, so a row a stop or crash left open is closed as
  `stopped` when the forge boots. Writers see the last 20 at
  `/<owner>/<repo>/settings/machines` (in the settings frame for an admin,
  on its own for a writer who is not one), and in the terminal: the palette's
  **Machines of a repository** (`src/tui/screens/machines.ts`), writers only.

## The shell in the browser (#9472)

`/<owner>/<repo>/settings/machines` lists the machines with **Open shell**,
which goes to `/<owner>/<repo>/machines/<machine>/shell`: the same path as the
socket, answered as a page when it is not an upgrade. Writers only, like the
socket (a reader is refused 403; a private repository or an undeclared
machine answers 404). The page renders on the server and draws the terminal
with one script:

- **The emulator** is [ghostty-web](https://github.com/coder/ghostty-web)
  0.4.0, vendored unmodified in `src/web/vendor/ghostty-web` (MIT; what was copied and
  its hashes are in its README). `src/web/machine-term-asset.ts` bundles it
  with the page's client (`src/web/machine-term-client.ts`) into
  `/assets/machine-term-<hash>.js` (about 75 KB, dropping the module's own
  inlined copy of the WebAssembly) and serves `ghostty-vt.wasm` at
  `/assets/ghostty-vt-<hash>.wasm` (423 KB); both are content-addressed and
  cached immutable.
- **The interface** to it is thin: `Term` in `src/web/machine-term-wire.ts`
  is `write`, `onData`, `resize` and `fit`, and all of the protocol
  (`wire`) is written against that, so it is tested without a browser and the
  emulator can be swapped without touching it.
- **CSP.** Only this page adds `'wasm-unsafe-eval'` to `script-src` (the
  page option `wasm` in `src/web/layout.ts`): it admits compiling
  WebAssembly, not `eval` or inline script. Every other page's policy is
  unchanged.
- **Reload.** A reload opens a new socket, which joins the person's running
  session (above). On open the page sends its size; a connection's first
  size equal to the pty's own makes the server pass the pty through one row
  less for 30 ms (`resizePlan`, `src/machines/shell.ts`), because the kernel
  signals only a change and tmux redraws the whole screen on the signal. So
  the reloaded page shows the screen, not a blank one.
- **Resize.** The page refits the terminal to its box when the box changes
  (debounced 100 ms) and sends one resize frame per new size, never the same
  size twice; tmux redraws the prompt at the new size.
- **Closed.** The status line says why the socket closed (the shell exited,
  idle, the forge cannot hold a shell) and to reload to reattach.

Try it: on a preview, sign in as a writer of a repository, open
`/<owner>/<repo>/settings/machines`, press **Open shell** on `standard`. A
forge that cannot hold a cell says so in the status line and closes.

## Not done yet (split from #9418)

Disk ceilings are not declared (#9460); the tools are declared, not yet
installed in an image (the brief reports which are on PATH).
