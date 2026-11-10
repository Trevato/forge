# Notes

`/notes` is one box and a list. Type an idea, press Enter (Shift+Enter for a new line; the Save button when there is no script), and it is kept as a thought (`keepThought`, source `composer`, the same door the API and MCP use). Your notes are listed newest first, yours alone.

The planner (`crew/triage.ts`) places every note without asking, within a couple of minutes:

- a long dump becomes several issues: its bullets or numbered lines, else its blank-line paragraphs (`splitIdeas`, at most 8), each issue linked back to the note;
- an idea that clearly touches an open issue (most of its words shared, not a reversal) is added to that issue as a comment instead of a duplicate (`attachTarget`);
- a repeat, a reversal, a vision and a decision behave as before.

Each note carries one line (`core/note_line.ts`): *Waiting for the planner*, *Planned*, *Building*, *In review*, *Shipped in version N*, with links to the issues and pulls. A split dump says "3 issues: 1 shipped, 1 in review, 1 planned". The version is read from the release commits of the forge's own repository, so it is named only for work shipped there; elsewhere the line says *Shipped*.

Reached from the Notes button beside the tell box on home, the user menu, and the palette (`Ctrl/Cmd+K`). Writes need a session or a token with `rw` scope and the same origin.

## The planner decides; you overrule in one tap

Nothing waits for you to accept a note. The planner gives each one a verdict and the line says which, and why:

- **Accepted**: it opened or amended issues; the line then follows them (planned, building, in review, shipped). Tap *Not this* while it is only planned and the issues it opened are closed.
- **Declined**: nothing to build (an empty note, a bare repository name). Tap *Build it anyway* and an issue is opened from it.
- **Duplicate**: the same ask as an earlier note; the line says when you asked and where that stands, and the earlier issue is raised. Tap *Build it anyway* for a new issue.
- **Snoozed**: it says "someday", "not now", "eventually", "low priority" and the like, and the repository has a Later gate: the issue is opened behind the gate. Tap *Build it anyway* to let it out.

An overrule is `POST /notes/:id/overrule` (`do=build|decline`), kept as the setting `note.<thought id>` on you; the planner's own placement is never rewritten, only added to.

The terminal has the same door: the palette's "Notes" (`src/tui/screens/thoughtnotes.ts`) writes with `n`, lists your own notes with the same one-line state, and `b` takes the tap the line offers. An overrule is once per note and only what the line offers; a repeat or a stale form does nothing. "Snoozed" is judged per idea in a dump, and "backlog" is not a snooze word.

## Notes from an app's forge button

A note sent from an app's forge button (or the terminal's "Tell the builders") files a from-app issue, and the sender is told its number at once: "Filed as #N". Anyone the repository would show the issue to (`canRead`, so a signed-in reader of a private repository too, not only a public app on a public repository) also gets the issue's link and the repository's; everyone else gets the number and no link. The list shows `#N` beside each note. The browser button links only to the forge's own origin. In the terminal (`src/tui/screens/notes.ts`) the sender is the SSH user: the confirmation reads "Sent as #N, owner/repo/issues/N" and the list and moderation screens carry `#N`; the terminal has no clickable link.

The issue also carries a closed fold, "Where this came from" (`actions/note_context.ts`): the build the app was serving and up to five recent console errors from the sender's page, each cut to 200 characters and scrubbed of anything shaped like a secret or a URL query. The page itself is the issue's `Page:` line, said once. Markdown accepts one flat fold (`<details><summary>Title</summary>` … `</details>`, each on its own line, a title of plain characters); an unclosed one is closed, a nested one is text.

The crew's answers come back to the sender: under each note the button's list (and the terminal's "Notes from the app", where picking a note shows them) carries the comments on its issue by the repository's crew and writers, with author and time, oldest first. Anyone else's comments stay on the forge. The button shows the latest five and says how many are earlier.

When a pull that closes a note's issue merges, the forge leaves one plain-words comment on it (`crew/note_closed.ts`): what was wrong and what changed, from the pull's description, with no hashes or links, saying "the next release" until one is cut, then rewritten to name it ("release 57 (10 Nov 2026)"). Both ways a merge closes an issue (the merge itself, and a reviewer's box pass on an already-landed pull) go through `noteShipped`. The forge marks its comment in `note_shipped`, so a person's comment with the same opening never stands in for it. The button shows it as a reply and the note reads shipped.
