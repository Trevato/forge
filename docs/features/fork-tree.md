# The fork tree

Every repository sits in a tree of forks. The fork tree reader (`forkTree` in `src/actions/fork_tree.ts`) returns
the part of it you may read: the highest ancestor you can see, then every fork below it, so siblings and cousins
come with it. A fork you cannot read is left out before anything is counted, and everything under it goes too.
No git is read.

## Terminal

Open the palette and choose **Fork tree of a repository**, then type `owner/name`. The repository you asked
about is marked `*`, each generation is indented, and each fork says in one word how it follows its parent: `follows`, `proposes` or `severed` (`FOLLOW_WORD` in
`src/actions/follow_words.ts`, the same word the fork's family tree on the web says).
A repository you may not read answers "not found", as everywhere else.

## MCP

```json
{ "name": "fork_tree", "arguments": { "repo": "alice/app", "depth": 4, "limit": 200 } }
```

Returns `{ root, nodes: [{ repo, parent, depth, follow, word }], truncated }`; `word` is the one word above (empty for the root). `depth` is 1-8 (default 4) generations
below the root; `limit` is 1-200 nodes (default 200). `truncated` is true when more exists than is shown.

- The repository asked about is always in `nodes`, with its ancestors, even when it lies deeper than `depth` or
  `limit` would reach.
- The root's `follow` is `autonomous`; any other fork is `take-updates` or `offers`.
- A repo you cannot read gives `{ root: null, nodes: [], truncated: false }`.

## Cost

One query per generation plus one for the follow modes, not one per fork; the test counts statements
(`test/fork-tree-reader.test.ts`), not a clock.
