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

## Speaking the home page's language (#9741)

The list is rows on the page, not a card: the list card is `.card.bare` (no box, no hairlines between rows), and
space does the separating. Its title is the system's row title, the same type the home page's rows use (no size of its own, no padding literal); the one link is the title's row. Filters, labels, the word and the pillar are unchanged. No new class.

## An issue's side cards (#9816)

The side column of an issue (`labelsCard`, `assigneeCard`, `issueTeamsCard`, `dependenciesCard` in
`src/web/pages/thread.ts`) reads like the pull page's side: a small heading over its rows, `.card.bare`, no box and
no hairline. Chips, forms and empty lines are unchanged; titles stay escaped. The pull page draws the same label and
assignee cards, so it follows. No new class. `test/issue-side-bare.test.ts` holds the shape.

## Calm: a row is a title, a state word and a time (#10415)

On the Issues, Pulls and Runs lists (`src/web/studio/lists.ts`) a row carries its title, its state word and one time.
Gone from the row, still on the page it opens: the Flow-first button (still on the issue page, in its header), a pull's pipeline
step and the tell it answers, a run's sha, wait reason and duration, who has an issue. A stopped pull, a failed run and a run paused on a limit keep one
clamped reason line; an imported issue keeps its origin tag. The issue page drops "nobody has it yet" (the state word says it). Empty states are one line
(`Nothing open.`; a set filter is named). First-view budgets fell: issue 76→72 words, issues list 32→30,
pulls list 31→24, runs 46→38. No new class.
