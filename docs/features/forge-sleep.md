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

## Apps sleep on the profit slider

The apps a forge runs sleep too, and the profit slider on the economics page says when. The next request wakes a sleeping app.

- **Move the slider.** Each sweep, once a minute, reads the slider's position. No restart is needed. Production sleeps after 10 min with no requests at position 0, after 1 day at 50 (the default) and never at 100. A quiet pull's preview stops after 1 day at 0, 3 days at 50 and never at 100. When an app goes to sleep, its deploy log names the window and the position, e.g. `asleep: nothing asked for it in 10 min (economy 0); the next request wakes it`.
- **Keep one app awake.** Put `"always_on": true` under `app` in its `forge.json` and push. Its production never sleeps, whatever the position. Its previews still follow the slider. Any value other than `true` or `false` fails the deploy and says why. The app page shows the row "Sleeps: never (app.always_on)". The terminal's deploys screen adds "never sleeps (app.always_on)" to production's line.
- **Pin the preview age.** Setting `FORGE_PREVIEW_IDLE_DAYS` on the forge fixes a quiet pull's preview age, whatever the position. `0` keeps every preview warm. Leave it unset to follow the slider.

Code: `src/apps/sleep_window.ts` (windows, `previewIdleMs`), `src/apps/runtime.ts` (the sweep). Tests: `test/sleep-window.test.ts`, `test/apps-sleep-slider.test.ts`, `test/preview-idle-slider.test.ts`.
