# Pulls

## Resolving conflicts without a clone

A conflicted pull has a page at `/:owner/:name/pulls/:number/resolve` (writers
only). Each conflict block is a card: ours (the base branch), theirs (the pull
branch), both, or your own text. The choices travel in the query string, so
the page keeps no state and the preview writes nothing.

**Finish** is a same-origin `POST` to the same path (write access, `rw`
scope). It carries the choices plus the `head` and `base` commits the page was
drawn from. Then, with no working tree, no clone and no agent:

1. The live head and base are read; if either differs from what the page
   carried, the request is refused with "the branch moved since this page was
   drawn" and nothing is written.
2. `git merge-tree --write-tree` produces the tree of base + head, with the
   conflicted file holding markers. Every block must have a choice; a block
   with none is refused.
3. The file is rebuilt from the choices (`applyChoices`), written as a blob
   into a temporary index seeded from that tree (its mode kept), and
   `write-tree` makes the resolved tree.
4. `commit-tree` seals it as the person, with the head as first parent and the
   base as second, so the pull merges cleanly afterwards.
5. `update-ref` moves the head branch with a compare-and-swap on the old tip,
   so a push landing in between refuses rather than loses work. The push is
   announced on the bus like an API write, the pull's head is tracked, and the
   person lands back on the pull, which re-checks as mergeable.

Not offered: pulls with more than one conflicted file, a conflict with no text
blocks (delete/modify, binary), cross-repo pulls and mirrored repos. Those are
resolved in a checkout; Finish says so and writes nothing.

Code: `src/actions/finish-conflicts.ts`, `src/git/write.ts` (`commitFiles`
with `seedTree`, `mergeParents`, `expectTip`), `src/web/pages/conflicts.ts`.

The terminal's conflicts screen (`v` on a conflicted pull) finishes with `f`,
through the same `finishConflicts` and the same refusal texts
(`FINISH_REFUSALS`).
