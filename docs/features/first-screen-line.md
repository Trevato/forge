# The line about a sent forge's first screen (#11433)

On `/forges` and in the terminal's "Forges you sent", a forge not yet claimed carries one line: the apps chosen (or "the apps you pick"), the crew working, and the three next steps, in the first-login card's own words.

- One source: `STEP_TITLES` and `firstScreenLine` in `src/core/next-steps.ts`; the card and the line both read them.
- Shown only while unclaimed (`firstScreenOf` in `src/spawn/clients.ts`); once claimed the recipient has seen it.
- Page: a `data-first-screen` child row in `forgeRow` (`src/web/pages/forges.ts`), in the first paint. Terminal: `forgeLines` (`src/tui/screens/forges.ts`).
- Tests: `test/first-screen-line.test.ts`.
