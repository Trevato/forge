# Durable jobs

A job is code that waits (`sleep`, `waitFor`) without a process, survives restarts and deploys, and runs each step once. The rules are the "Jobs" part of "Time" in `docs/APPS.md`; the library and a worked example are in every new app (`src/jobs.ts`, `src/reminder.ts`, README "Jobs").

1. In a new app, open a note signed in and press **Remind me tomorrow** (`POST /notes/:id/remind`): a run of the `remind` job starts, loads the note, and waits a day for the note to be removed.
2. Open the app on the forge: while the run holds a timer, its page has **Jobs → See the job runs** (`/:owner/:name/app/jobs`). The row says `waiting for removed:<id>, until <time> at the latest`. **Cancel** stops it; a failed run offers **Retry from the failed step**.
3. The same from a script: `curl -H "authorization: Bearer $TOKEN" $FORGE_URL/api/v1/repos/<owner>/<name>/jobs`, `curl -X POST …/jobs/<run>/cancel`; the `app_deploy` MCP tool does it with `action: "jobs"`, `"cancel_job"` or `"retry_job"` (`name` is the run id).
4. The terminal: with the app's repository open, the palette offers **Job runs** (a writer's, while the app holds a job timer); `c` cancels the run under the cursor, `t` retries a failed one, `g` reads again (`src/tui/screens/jobs.ts`).
5. A run that fails for good (a step out of retries, or a changed job) asks the owner once.

Where the code is: the runtime `src/jobs.ts` in the app template (`templates/app-template.json`; its tests, `src/jobs.test.ts`, run by `test/template-jobs.test.ts`), the forge's rows and steering `src/actions/jobs.ts`, `src/http/api/jobs.ts`, `src/web/studio/jobs.ts`, the no-retry answer in `src/apps/timer_fire.ts`, and the ask in `scheduleLines` (`src/actions/schedules.ts`). Tests: `test/jobs-doors.test.ts`.

What the forge could not do: `trevato/app-template` is a separate repository, which this change cannot push to. The bundle carries the new files, so a forge without that repository hands them out; a forge that reads the repository needs the same files (`src/jobs.ts`, `src/reminder.ts`, `src/jobs.test.ts`, the routes and button, the README section) landed there, and `scripts/take-template.ts` then replaces the bundle.
