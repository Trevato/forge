# Timers and schedules

The forge fires a signed `POST` at an app on a clock, waking the app if it sleeps. The rules are the "Time" section of `docs/APPS.md`; this is how to use and check it.

1. Declare it in the app's `forge.json` (`schedules`, see APPS.md) and merge to the default branch. The forge reads the file once per commit each environment serves, within a minute.
2. Open the app's page: the **Schedules** section shows each schedule's next run, last run and how it went. **Run now** fires one now without moving the clock; **Pause** holds it.
   In the terminal, open the repository and pick **Schedules** from the palette (`src/tui/screens/schedules.ts`): `r` runs the row under the cursor now, `p` pauses or resumes it. A write from the terminal, the page, the API or the MCP tool is a `schedule.steered` event, so the others redraw live. What a run answered and why it failed (`response`, `error`) are a writer's: every door gives a reader null.
3. `curl -H "authorization: Bearer $TOKEN" $FORGE_URL/api/v1/repos/<owner>/<name>/schedules?runs=20` answers the rows and the newest runs; the `app_deploy` MCP tool does the same with `action: "schedules"`.
4. In the app, copy `src/once.ts` (new apps have it) and wrap the job: `const d = fromForge(req, identityKey); if (!d) return 401; return once(db, d.key, job)`.

Where the code is: `src/apps/cron.ts` (cron in a timezone), `src/apps/schedule_spec.ts` (the `forge.json` block), `src/core/timers.ts` (the rows), `src/apps/timer_fire.ts` (wake, sign, retry, late, pause), `src/apps/timer_service.ts` (the loop), `src/actions/schedules.ts` and `src/actions/timers.ts` (what the page, API and MCP share). Tests: `test/timers.test.ts` (fake clock), `test/timers-api.test.ts`, `test/timers-sync.test.ts`.
