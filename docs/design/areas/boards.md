# Boards

## Held files card (`#board-holds`)

Drawn from existing components only: `card` with an icon head, `row` per hold
(path, repository, who and when, a ghost Release button in the trail), and a
`field` form to hold another path. No new class. It lists the holds of the
repositories the viewer administers and shows when there are none, because it
holds the form. A person who administers a repository but is not a forge
admin sees `/boards` as this card alone.
