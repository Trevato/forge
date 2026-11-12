# What became of the first ask

After a new forge's first ask, home says what became of it, in plain words:

- a builder on it: "atlas is building it", "atlas is ready to start on it";
- in line: "Waiting for a builder: 2 ahead of it" (the queued agent runs on the person's apps made before this one) or "Next in line for a builder"; "Waiting for a builder" only while no run exists;
- ended: "atlas stopped on it: the run failed", "atlas's run on it was cancelled", "atlas finished a run on it and opened no pull";
- missing: "No AI account and no included credit left: add a key".

The ask is the person's oldest issue on their apps (the spawned forge's and their own; an app's direction is no ask), so a later issue never replaces it. The status ends with the first ask: once it is closed or its builder opened a pull. The first ask's flash names the app and the issue ("bakery, issue #1: …").

- **Web:** a row at the top of the card on `/`; a missing key shows one quiet link (admins: "Add a model key", others: "See the plans"); the primary button stays on the step. While the ask is building, its app's crew row is left out, so the builder is named once.
- **Terminal:** the first line of the client's home in `forge tui` (`src/tui/screens/dashboard.ts`), with the action's path.
- Both read `askStatus()` in `src/core/ask-status.ts`.
- Try it: spawn a forge, claim it, ask for something on `/`, open `/` or run the terminal.
- Tests: `test/next-steps-ask-status.test.ts`, `test/first-ask-flash.test.ts`.
