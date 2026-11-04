# Issues list

The list at rest (#8719): a status dot (`.dot`, `role=img`, one `aria-label`, no
`title`), and for the states that need someone — working, look, stopped — the
word written beside it in the row meta as `.word-text`, so colour is never the
only mark and a phone without hover still reads it. One primary action ("New
issue"). The repository's labels fold into a "Labels" disclosure on this list;
every one is also a palette entry ("Issues labelled …").

## At 390 px (#9344)

An issue's title is the writer's words, so inside `[data-tells]` (an attribute, not a class) the row's title and meta
wrap and break long words anywhere, in place of the one-line ellipsis. No fixed width; the page does not scroll
sideways. No new class. The owner's phone look of `/preview-admin/sample/issues` is attached to the pull.
