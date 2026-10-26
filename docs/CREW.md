# The crew's shell

An agent's shell runs inside Claude Code's sandbox (`src/crew/sandbox.ts` is
the policy, `src/crew/claude.ts` the settings): the network is the forge and
the package registry, writes stay in the clone and the run's own `tmpDir`,
and the machine's temp directory, the forge's data and the operator's
credentials are unreadable. No command runs outside it on request.

Bun's install cache is one per repository, `<data>/crew/.cache/<repo id>/bun` (`BUN_INSTALL_CACHE_DIR`): every run on a repository shares it, no two repositories do, and deleting the repository deletes it.

## Running this repository's tests inside it

On Linux the sandbox refuses the bind of a unix socket, and the forge's
internal listener (the git hooks' door) is one. Claude Code can only allow
unix sockets all or none, which would open every socket the machine has, so
the boundary is kept instead: a run's environment carries
`FORGE_TEST_SOCKET=port`, and the forge listens on a loopback port
(`tcp:127.0.0.1:<port>`, `src/git/hook-address.ts`) where it would use a
socket. Loopback ports were already allowed (`allowLocalBinding`), and
`localhost` outside the sandbox stays unreachable.

What an agent can run: the type check and `bun test` over `test/`, with no
failures. A cell reaches its egress proxy through a unix socket, which cannot
be put on a port, so in port mode `cellsAvailable()` answers no
(`FORGE_TEST_SOCKET=port: no unix sockets`) and deploys and checks run
uncontained, as with `FORGE_CELLS=off`. The suites that are about sockets and
cells themselves skip in port mode and show as skipped: stale-socket recovery
and two forges on one data directory (`test/hardening.test.ts`), the egress
proxy and the cell-limit and probe suites (`test/contain.test.ts`), and the
socket-copy test in `test/apps-adversarial.test.ts`. The forge's check runs
them on every push and sends the log back.

Not proven from inside a sandbox: that a sandboxed shell reaches its own server
and is still refused `localhost` outside the sandbox and every `denyRead` path.
Nesting a sandbox is not possible there, so `test/crew-sandbox.test.ts` checks
the settings that enforce it (`allowLocalBinding` on, `allowAllUnixSockets` off,
the `denyRead` list) and not the boundary itself.

## Where a run's time went

Every run that started ends its log with one `timing: run ended …s after the run started — clone … · brief … · harness …` line (plus `wrap-up` when the reserve was used), whatever way it ended; `src/apps/timing.ts` draws it.

## The sentinel (#1131)

The forge hunts its own faults. `src/crew/sentinel.ts` runs on the autonomy
clock (a hunt an hour; a signal may bring one sooner, never within ten
minutes). It reads what the forge already holds — the run table, the decision
ledger (`retry stop` streaks, `guard` parks, a direction at its cap),
`sqlite_master` for triggers the schema does not create, and the error ring —
and names each fault with the evidence quoted (secret-shaped text scrubbed).

Each finding is exactly one open issue, keyed so it is never filed twice; a
finding still there is a comment, and only when the evidence changed. The board
strip shows the last hunt and the count of open findings.

Left to a person on purpose: ingress routes at the edge are not in the
database, and the sentinel opens no pull itself — a finding with a mechanical
fix says what it is, and a run of the crew picks the issue up.

## Hot files (#5934, #6235)

A build is not started while a file its issue names is touched by 5 or more
open pulls (`HOT_PULLS`). A pull whose diff against the base tip touches more
than 60 files (`WIDE_PULL`) counts toward no file's heat: such a diff is
almost always the base's history on a conflicted pull, not its own work, and
five of them would make hundreds of files hot and hold the whole map. It is
named instead, with its file count, on the feed post that says what waits
(`too wide to count: #4840 (1,081 files)`), so a person can close or rebase
it. A real sweeping change, such as a rename across the tree, goes uncounted
too; it conflicts with everything anyway, and it is named.
