# Pause and resume a maintenance duty (#11205)

Each duty the forge's maintenance runner runs (`src/maintain/registry.ts`) has an on/off switch, kept in `maintenance_duty_state`. A paused duty is skipped by every tick. After three errored runs in a row (it threw, timed out or had a finding refused) the runner pauses the duty itself and says why: "paused after 3 errors in a row; last error: …". Resuming starts the count again, so one more error does not pause it at once.

All doors are for a forge admin and call one function, `switchDuty` in `src/maintain/pause.ts`, so they say the same words.

- **On the web.** `/maintenance` lists each duty once; the ones the runner runs carry their state ("on", or "paused since … ; why") and one **Pause** / **Resume** button (`POST /maintenance/duties/:name`, same-origin only, form body bounded, `paused` is `yes` or `no`).
- **In the terminal.** Ctrl-K, **Pause or resume a maintenance duty** (an admin who is a person): `j`/`k` choose, Enter or Space flips, Esc closes. It writes the same row, so a web viewer sees it on its next load.
- **Over the API.** `GET /api/v1/maintenance/duties` lists the states; `POST /api/v1/maintenance/duties/:name` with `{"paused": true|false}` needs an `admin`-scope token.
- **In the MCP.** The `maintenance` tool: `pause-duty` and `resume-duty` with `duty`.

An unknown duty name is 404 (a flash on the page); a `paused` that is not a boolean is 422.

Tests: `test/maintain-pause.test.ts` (the three errors, resume from the API, the page and the terminal, the gates).
