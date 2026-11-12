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

## From the pull page and the terminal

**Resolving a conflicted pull.** When a pull conflicts with its base, a writer sees **Resolve** in the "Can't merge" box, which opens `/:owner/:name/pulls/:n/resolve`: one file at a time, each conflict block a card with the two sides named by their branch and the taps **Keep <base>**, **Keep <head>**, **Keep both** and **Write my own** (words typed in the box count as your own), a running "2 of 3 resolved", and the merged file beneath. The choices ride in the query string until you press **Finish**, which commits them: the resolved file becomes a merge commit on the pull's branch (as you, the base as second parent, built with git plumbing — no clone, no agent), and the pull re-checks as mergeable. Finish is for writers with `rw` scope and refuses, writing nothing, when the branch or base moved since the page was drawn, when a block has no choice, when the pull has more than one conflicted file or a conflict with no text blocks, and for cross-repo or mirrored pulls. In the terminal, `v` on a conflicted pull does the same: `n`/`p` move over the blocks, `o`/`t`/`b` take ours, theirs or both, `e` opens a box for your own text, each file shows "N of M resolved" with its merged file beneath, and `f` finishes with the same refusals in words. On a conflicted pull held by an agent, the same page (and the same view in the terminal) also offers **Ask the crew to fix it** to writers with `rw` scope: it queues one `resolve` run for that agent, on the pull's own branch, with a brief carrying both sides' commits, the conflict blocks and the tests that cover them. The agent merges the base in, commits the resolution and pushes; its report becomes the note on the pull. Until the run settles the card says it is working and refreshes itself on the run's events (in the terminal, `r` looks again and never asks), and a run that fails says why. When it lands the card shows the note, the commit the run left (kept on the run, so a later push is never called the crew's) and the files to edit by hand; once the head moves on, the card goes. The tap is refused, writing nothing, for a reader, a closed pull, a pull with no conflicts, a pull no agent holds, one the crew is already working on, and when the crew's ceiling or breaker has no room. In the terminal `c` in the conflict view is the only key that asks, with the same refusals in the same words. Readers and guests get neither.
