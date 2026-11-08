# Hosted forges that scale to zero

A person (or their assistant, over the MCP `spawn` tool with their consent) makes a forge at `/forges/new`, the address `<name>--<this host>`. Free within the limits below; no payment path yet.

- **Sleep.** A forge with no request for `FORGE_CHILD_IDLE_S` (600) sleeps: a hosted child's App and apps close, a cell child's process stops. Data stays under `children/<bodyId>`. The next page load, `git push` or API call wakes it. A page for a sleeping cell forge answers a plain "waking up" page at once (git and API calls wait up to 4 s) (503, `retry-after`, reloads itself); a hosted one opens in-process.
- **Limits, each refused in words.** The admin limits `forges.per_person` (3) and `forges.storage_mb` (1000 MB), set at `/admin/limits` (the same list is on the terminal's limits screen), each refused in a sentence naming the limit and the person's use (site admins exempt), `FORGE_CHILD_AWAKE_MAX` (8 awake at once; sleeping forges do not count), `FORGE_CHILD_WAKES_PER_HOUR` (20 per forge), the admin limit `forges.wakes_per_person_hour` (30 wakes an hour across one person's forges, refused with "waking too often, try in N s"), plus the existing size/quota limits (`FORGE_CHILD_*_MIB`), and each cell's own disk cap.
- **Owner.** `/forges` shows awake/asleep, size, last activity, with Stop (sleep now) and Remove (ledger and data).
- **Secrets.** A child starts from `childEnv` and never sees this forge's model credential; the person brings their own or its crew stays off.

Code: `src/spawn/sleep.ts` (limits, waking page), `src/spawn/host.ts` (`wakeGate`, `sleepIdleChildren`), `src/spawn/vouch.ts`, `src/spawn/manage.ts`. Test: `test/forge-sleep.test.ts`.

## Doors
- Web: `/forges` (awake/asleep, size, last activity; Stop; Remove asks on `GET /forges/:name/remove` first). Create: `/forges/new`, or the one-field form on `/agents`, which posts the name straight to the spawn (one step, defaults for the rest).
- Terminal: the "Forges you sent" screen lists awake/asleep and size, `s` stops one, `x` removes one (confirmed); both call `spawn/manage.ts`, which writes `forge.stopped` / `forge.removed` to the event outbox, so web viewers see the change. Create: the New forge screen (`src/tui/screens/newforge.ts`). MCP: `spawn`.
- A stranger's request wakes a sleeping forge only within an address rate (`takeDoor`) and the awake ceiling, and never refreshes its idleness. A request does only when the child itself vouches for it: its session cookie or token (Bearer, `token`, or a `forge_` token as the Basic password) is looked up read-only in the child's own database (`src/spawn/vouch.ts`), so a made-up `authorization` header or `forge_session` cookie is a stranger's. A Basic password is not checked there and counts as a stranger's. A forge with a request in flight or crew work queued or running is not put to sleep. Not covered: an open websocket, and a response body still streaming from a cell forge after its headers.
- The wake path for a cell forge, and the hold around cell forwards, are not exercised by tests in this sandbox (cells are skipped).
