# Notes

`/notes` (`src/web/pages/notes.ts`): the composer is `.note-box` (a textarea and a bar), and each row's one-line state is `.note-line` inside a §5 row's meta.

## At 390 px (#9352)

A note is whatever a person typed, so inside `[data-notes]` (an attribute, not a class) a row's title and meta wrap and
long words break anywhere, in place of the list's one-line ellipsis; the row aligns to its top so the badge and the
overrule button sit by the first line. No fixed width; the page does not scroll sideways. No new class.

## Rows, not boxes (#9731)

The notes are a `listCard(rows, { extra: "bare" })`: rows on the page's one background with no frame (the shared
`.card.bare`, docs/design/areas/lists.md). A row's state is the words in its one `.note-line` ("Planned · 2 issues",
"Shipped in version …"), so the trailing badge is gone. The empty state is one muted line, not a card. The action,
`keepThought`, and the overrule button do not change. No new class.

The amber tone that building and in-review notes once carried is gone on purpose: the words are the state, and the page
has no other colour for them. The 390 px rule above still holds, now without the badge.
