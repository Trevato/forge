# Family

`/family` is a tree of forges: a name and one plain line each (how it follows,
how far behind). It uses the shared list rows with `.list.bare-tree`
(components.ts): no card, no rules between rows, no vertical rule; children are
indented by `--tree-indent`. Version, last seen, proposals and placement are
not on the row; `/forges` carries them.

## A fork's Following section and its forks lineage

On a repository page, `#following` and the lineage of forks are a heading over
rows with no card: `section.settings-block` with the heading (the parent, and
the state as a badge), the sentences in `.stack`, `row`s, and the actions in a
`.bar` beneath. No new class; the `bare` option of `followingCard` now only
drops the top margin.
