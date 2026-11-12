# Each app with its crew member

On a forge made for someone, every app is one plain line: the app's name, then
who in the crew is on it and what they are doing, e.g. `bakery` — "atlas is
working toward Run Maria's bakery". An app whose direction is closed or has no
assignee reads "nobody is on it yet". The tracker's "Direction: " label is never
shown.

- **Web:** the first-login card on `/` (the row's title is the app, its meta the sentence; the row opens the app, never an issue number; the first line of a row is the sentence, the app's name beneath).
- **Terminal:** the client's home in `forge tui` (`src/tui/screens/dashboard.ts`), one line per app.
- Pull and issue numbers, run ids and numbered branch names are cut from the goal together with the clause that introduces them (`plainWords`); a goal that is only identifiers says the app's name. Ordinary words ("run 5 miles") stay.
- Both read `appCrew()` in `src/core/app-crew.ts`, so they say the same thing.
- Try it: spawn a forge, claim it, open `/` (or run the terminal) — the line is there before any run starts.
- `test/next-steps-crew-words.test.ts` asserts the exact sentences from `appCrew()`, the source the terminal home reads, so a mangled sentence fails for both doors.
