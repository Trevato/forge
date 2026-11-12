# Pulls drifting from main

An open pull more than 25 landings or 6 h behind its base is listed on `/boards` (and so `/flow`) under "Drifting from main", furthest first, each with one button, "Bring up to date". Nothing is shown when none drifts. The same fact is the `drift` alarm.

- **Page:** `src/web/pages/boards-drift.ts`, a plain section of `/boards` (admin only, as the page is). The button posts `POST /:owner/:name/pulls/:number/update` (`updateSubmit`, `src/web/studio/actions.ts`): same-origin, a viewer of the pull, and a writer of the repository; it asks the pull's agent to merge main into its branch (`bringUpToDate`) and lands nothing. Closed pulls, pulls with no agent, and a pull that has used its tries are refused in words.
- **Terminal:** the palette entry "Drifting pulls" (`src/tui/screens/drift.ts`, admins who are people); `b` or enter asks, `r` reads again. Same reads, same action, same refusals.
- **MCP:** `flow` with `{ kind: drift }` lists them: `{ drifting: [{ repo, number, landings, hours }] }`. There is no verb to ask the agent yet; use the route.
- **Reads:** `src/flow/alarm_drift.ts`, git per pull cached by head and tip; merged and closed pulls never count.
- **Tests:** `test/flow-alarm-drift.test.ts`, `test/studio-update-pull.test.ts` (writer, non-writer, closed, cross-origin), `test/tui-drift.test.ts`.
