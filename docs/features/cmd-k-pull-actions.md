# Cmd-K: a pull's actions

On a pull page, either tab, press Cmd-K (Ctrl-K) and the palette lists what the page lets you do, under "This pull". Type a verb ("close", "check", "reopen") and press Enter. Every row is something the page itself offers you; a reader is never shown a row the server would refuse.

Both tabs build their rows from one function, `pullRoster` (`src/web/studio/pull_roster.ts`), from the values the page already draws its controls by.

**On both tabs**
- Conversation, Files, and for a pull from this repository Branch and Commits.
- Comment, for anyone signed in, until it is merged.
- Reopen pull request, on a closed, unmerged pull, for its author or a writer. It posts the page's own Reopen form (`state=open` to `…/state`). The page draws its Reopen button by the same rule.

**On the Conversation tab** the page folds its actions away, so these rows are links that land on them: Ship (read "Bring up to date" on a conflict), Check again, Hold, Close pull request, Edit and Take it back, each shown by the rule the page shows its control by.

**On the Files tab**
- Review, for anyone signed in, while it is open.
- Assign, and Labels when the repository has labels, for a writer.
- Check again, for a writer while it is open: posts to `…/checks`.
- Merge pull request: posts a merge commit to `…/merge`. It is shown only when the merge box's button is enabled (a writer, git, review and checks agree). There is no Squash row; squash from the merge box.

**How a row posts.** A row that changes something carries the fields to post; the palette builds a hidden same-origin form with them and submits it, exactly as the page's button would, so the server's same-origin and permission checks apply unchanged. It is never followed as a GET, and it is not kept in Recent, where replaying it would be one.

Not in the palette: land-past, resolving a review thread and per-line review comments. They need typed input or a place in the diff, so they stay on the page.
