# Talk

`/talk` (#7652) is the person's one conversation with the forge: a log, a composer, and Confirm and Cancel for a held action.

- `.talk` — the page's column: at most 760px, centred, `min-width: 0` so nothing pushes the page sideways at 375px.
- `.talk-log` — the ordered list of turns; its `data-last` is the last turn id the stream resumes from.
- `.talk-turn` — one turn; wraps anywhere, so a long word or URL never scrolls the page.
- `.talk-person` — the person's words: a right-aligned bubble, pre-wrapped.
- `.talk-agent` — the agent's reply, markdown, full width, no bubble.
- `.talk-tool` — what the agent did, one muted small line.
- `.talk-confirm` — a held action's card: the sentence, then Confirm and Cancel at 44px high.
- `.talk-compose` — the composer, sticky to the bottom of the viewport (padded for the phone's safe area), so it stays reachable; its textarea is 16px so iOS does not zoom.
- `.talk-status` — one polite line (sending, answering, an error); it always takes its line, so nothing shifts.
- `.talk-more` — the "Earlier" link above the log.
- `.talk-body` — the text of one turn, above its meta line.
- `.talk-plain` — a person's words, shown as typed (line breaks kept).
- `.talk-meta` — who said it and when, with the copy button.
- `.talk-copy` — a quiet text button that copies a message or a code block.
- `.talk-suggest` — the starter questions on an empty chat; each fills the composer.
- `.talk-jump` — "Latest" button, shown when you have scrolled up from the end.
- `.talk-steps` — the quiet steps line under a reply ("read 3 files, opened #12").
- `.talk-links` — the links under a reply to what the turn opened or changed.
- `.talk-replaced` — a turn the person edited, regenerated or retried past: kept in the log, dimmer, labelled "replaced".
- `.talk-failed` — the plain-words line for a run that could not answer; Retry sits under it.
- `.talk-acts` — the row under the last message and last reply holding Edit, Regenerate or Retry; server-drawn, so it works without the script.
- `.talk-act` — one of those controls, at 44px high.

Under a reply, `.talk-cost` is one quiet line with the turn's dollars; above the log, `.talk-context` says how full the context is and, from 80 %, suggests a new conversation. Both are `small muted` text, no new colour.
