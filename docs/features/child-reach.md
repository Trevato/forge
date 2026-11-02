# "Running" is proven from outside

A child forge's process being up inside its cell says nothing about whether a
visitor reaches it. The parent asks the way a visitor does (#7959).

- **What is asked.** The child's home (`<child>--<parent>/api/v1/forge`, which
  must answer its own JSON `claimed`) and each public app
  (`<app>--<child>--<parent>/`, which must carry the `x-forge-app: <slug>` header
  the proxy writes on everything it carries back). A status alone proves
  nothing: the platform's wildcard standby page answers 200 for a mistyped
  `<app>--<child>.<apex>`.
- **Where it shows.** A failing child reads **Running, not reachable: deal-clock
  answered 404, not by the app** on `/forges` (with every address and its
  result under the row), in the terminal's Forges screen, in the MCP `forges`
  tool (`reach`), and in the result of `POST /api/v1/forges` / MCP `spawn`
  (`reach`, right after the child is made).
- **Alarm.** A new child is re-proved every 3 seconds for 3 minutes; if it never
  answers, `forge.child_unreachable` goes on the outbox and the notifier pages
  the owner (the `unreachable` flow alarm). Every 5 minutes the parent
  re-proves every finished child (a failure is confirmed once before it is
  believed); a change pages once, and `forge.child_reachable` ends it.
- **State** is `<data>/reach/<child>.json`, derived and rebuilt by the next pass.
- **Websockets** to a child's home or apps reach its cell: `forwardSocket`
  (`src/spawn/cell.ts`) opens the cell's side first, then answers the visitor.
- Tests: `test/spawn-reach.test.ts`, `test/spawn-reach-door.test.ts`,
  `test/spawn-cell-socket.test.ts`, and the real-cell `test/spawn-cell-e2e.test.ts`
  (skipped, and says so, where bwrap and socat are missing).
- **In the terminal:** open the palette (ctrl-k), "Forges you sent". A forge that
  is not reachable reads *Running, not reachable: …*, and under it one line per
  public address with its result (`NOT REACHABLE deal--kid--host/: answered 404, not by the app`).
- **Slugs are the forge's rule.** A child writes its own database, so a slug that
  is not `[a-z0-9-]` (`evil.example#`, `u@host`) is dropped before any address is built.
