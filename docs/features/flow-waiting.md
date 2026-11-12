# Flow: waiting

`/flow` (a forge admin who is a person) shows three quiet places work waits, each with its one action. A section with nothing to say draws nothing; when all three are quiet there is no card.

- **Approved, waiting on the merge queue** — per repository, how many approved pulls wait and how long the oldest has (`src/flow/approved_wait.ts`). Action: open the oldest pull.
- **Stale crew pulls** — crew pulls with no push for 7 days, oldest first (`src/flow/stale_fold.ts`), each with the note that folds it back into its issue. It only proposes; a person closes.
- **Work a crew fork never proposed** — a crew fork's branch 6 h old or more that heads no pull (`src/flow/alarm_unproposed.ts`), once, with a link to the branch. Branches are read with the branches page's helpers; no branch name reaches a shell.

Terminal: the palette entry "Pulls to land" (`src/tui/screens/waiting.ts`, for a forge admin who is a person, offered nothing to anyone else) reads the same `readWaiting` and lists the same three sections as text lines; a quiet lane says "Nothing waiting."

Cost: the unproposed-work scan reads git for every crew fork, so `readWaiting` holds its result for 60 seconds per process; the other two sections are plain queries and are read each time. Stale pulls carry their repository, so two repositories with the same pull number and branch stay apart.

Code: `src/web/pages/flow-waiting.ts` (reads and draws), mounted by one line in `src/web/pages/flow.ts`. Test: `test/flow-waiting.test.ts`.
