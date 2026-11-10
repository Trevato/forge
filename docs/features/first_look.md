# First look at a note from an app

A person's note from the forge button (`from-app` issue) gets one comment within a minute: which crew member has it and what they will look at first (`src/crew/first_look.ts`, started by `sendNote` in `src/actions/app_notes.ts`).

- One question to the model through `oneShot`: Sonnet, no tools, no shell, no files, a few cents, 45 s at most. The scope is fixed by the forge; the note cannot widen it.
- The note is quoted in a fence under a line that says it is data. The brief also carries the route of the page it came from (path only, no query; the page's title is not available to the note path), the repository's newest release, and the app's health: its newest contract probe (`probe` row), or a line saying none is recorded.
- If the model is off, rests, fails or is late, a plain comment says the crew has it and who.
- Only notes from people with an account get one; a stranger's note stays a suggestion until a writer adopts it.
- Whose money: the look is spent on the repo owner's account and daily ceiling, for any signed-in sender's note, at most `ONE_SHOT_USD` (5 cents) each. That ceiling is the bound by design; when it is spent (`resting`), or the owner has no account, the plain comment goes up.
- After the 45 s budget the plain comment is posted, but the one-shot keeps running to its own 60 s limit and still books what it spends; the cap and the ceiling bound that.
- Left out: live health from the running process (the note path has no runtime handle); the last probe stands in.
