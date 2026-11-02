# A person's reopen stands (#8373)

"Already done on main" is the crew's word, and a person's reopen outranks it.

- When the newest close or reopen of an issue is a reopen by a real, non-agent user, nothing the crew notes about the base closes it again: not live triage, not a superseded pull carrying `Closes #N`. A reopen with no actor does not count as a person's. A person closing it, or a pull landing for it, ends the reopen.
- An issue body with unticked `- [ ]` items holds a `Closes #N` open: neither a landing nor a superseded pull closes it. The pull gets one comment, `Left #N open: …`, naming the items, and it reaches viewers live as `pull.commented`. Checkboxes inside fenced code blocks are examples and are not counted.
- A landing that leaves an issue open also says so on the issue (#8482): `Left open after pull #P landed: …`, naming the pull and the items, live as `issue.commented`. The crew does not pick it again — it is held as `landed` (`crew/landed.ts`) — until a person who may direct the crew comments on it, edits it (ticking a box is an edit) or reopens it. An agent's comment does not lift it, nor does the landing's own note.

Not done: no setting turns this off; tick the items, or close the issue by hand.
