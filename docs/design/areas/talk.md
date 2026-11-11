# Talk

`/talk` (#7652) is the person's one conversation with the forge: a log, a composer, and Confirm and Cancel for a held action.

- `.talk` — the page's column: at most 760px, centred, `min-width: 0` so nothing pushes the page sideways at 375px.
- `.talk-log` — the ordered list of turns; its `data-last` is the last turn id the stream resumes from.
- `.talk-turn` — one turn; wraps anywhere, so a long word or URL never scrolls the page.
- `.talk-person` — the person's words: right-aligned, no box, pre-wrapped.
- `.talk-agent` — the agent's reply, markdown, full width, no bubble.
- `.talk-tool` — what the agent did, one muted small line.
- `.talk-confirm` — a held action: the sentence, then Confirm and Cancel at 44px high.
- `.talk-compose` — the composer, sticky to the bottom of the viewport (padded for the phone's safe area), so it stays reachable; its textarea is 16px so iOS does not zoom.
- `.talk-status` — one polite line (sending, answering, an error); it always takes its line, so nothing shifts.
- `.talk-more` — the "Earlier" link above the log.
- `.talk-body` — the text of one turn, above its meta line.
- `.talk-plain` — a person's words, shown as typed (line breaks kept).
- `.talk-meta` — who said it and when, with the copy button.
- `.talk-copy` — a quiet text button that copies a message or a code block.
- `.talk-suggest` — the starter questions on an empty chat; each fills the composer.
- `.talk-about` — the one line naming the subject (`?about=`), above the composer; no rule of its own: it is plain `small muted` text that wraps like any paragraph.
- `.talk-jump` — "Latest" button, shown when you have scrolled up from the end.
- `.talk-chats` — the conversations list above the chat (#8814): New, the person's conversations newest first, and the Archived filter link.
- `.talk-here` — the line naming the open conversation, with its Rename and Archive forms.
- `.talk-steps` — the quiet steps line under a reply ("read 3 files, opened #12").
- `.talk-links` — the links under a reply to what the turn opened or changed.
- `.talk-replaced` — a turn the person edited, regenerated or retried past: kept in the log, dimmer, labelled "replaced".
- `.talk-failed` — the plain-words line for a run that could not answer; Retry sits under it.
- `.talk-acts` — the row under the last message and last reply holding Edit, Regenerate or Retry; server-drawn, so it works without the script.
- `.talk-act` — one of those controls, at 44px high.

- Attachments (#8820) — drawn in `src/web/pages/talk.ts` and `talk_client.ts` from the existing `.badge` (a file's name) and `.btn` (Remove, Attach); the only new classes are layout:
  - `.talk-chips` — the row of chosen files above the box; hidden while empty.
  - `.talk-files` — the line of file badges under a sent message; each links to the owner-only download.
  - `.talk-attach` — the "Attach" file-picker label in the composer bar, a `.btn` that stays hidden until the script runs (the picker needs it).

Under a reply, `.talk-cost` is one quiet line with the turn's dollars; above the log, `.talk-context` says how full the context is and, from 80 %, suggests a new conversation. Both are `small muted` text, no new colour.
- `.talk-queued` — a message waiting for the running turn: the person's words, dimmed, its "Queued" line and Cancel under it.

Search (#8823) adds no component class: the form is a `.bar` with `.input` and `.btn`, and the results and the conversations list are `.list` of `row()`s (an "archived" `badge` as the trail, the match as the row's meta). The turn a result opens at is marked by a muted hairline on its left edge, `.talk-turn:target`, the one new rule, which replaces the two `.talk-chats li a` rules the rows made unnecessary.

#9690: the page speaks the home page's language: an `sr-only` h1, the conversations as a `.list` of rows, and no box round a turn, a tool call or a held action; the only hairline is above the composer. No new classes.

#11009: the builder layout. The pane's tabs are the `.tabs` component and the phone's Chat / Preview switch is `.seg`, both links (`?pane=`) the server draws, so it works with the script off; the pane is parted from the chat by one hairline, no box.

- `.talk-shell` — the grid holding the chats sidebar, the chat and the preview pane; one column on a phone, where `data-pane` (from `?pane=`) says which shows.
- `.talk-side` — the sidebar column wrapping `.talk-chats`.
- `.talk-tabs` — the phone-only Chat / Preview `.seg`.
- `.talk-pane` — the right pane: one head line (repository · pull or Production · Open on its own), `.tabs`, then the chosen panel; its left hairline is the only rule.
- `.talk-frame` — the framed live preview, no border.
- `.talk-step` — a tool call drawn as one closed line; opened, its `key: value` lines, one per line, in the tool card's plain paragraph.
