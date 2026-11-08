# Notes

`/notes` (`src/web/pages/notes.ts`): the composer is `.note-box` (a textarea and a bar), and each row's one-line state is `.note-line` inside a §5 row's meta.

## At 390 px (#9352)

A note is whatever a person typed, so inside `[data-notes]` (an attribute, not a class) a row's title and meta wrap and
long words break anywhere, in place of the list's one-line ellipsis; the row aligns to its top so the badge and the
overrule button sit by the first line. No fixed width; the page does not scroll sideways. No new class.
