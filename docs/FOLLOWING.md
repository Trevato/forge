# Following — a fork that keeps up with its parent

A fork is a copy under another name that can propose changes back. It also
**follows**: while nobody commits on its default branch, the parent moving is
the fork moving, fast-forward only, so a fork someone works on is left exactly
as they left it (`src/core/following.ts`). This page is the rest of the story:
what a fork with work of its own does when its parent moves, and what it shows.

The parent "moving" is a push or a landed pull. A merge moves its base with
`update-ref`, which announces no push, so following reads `pull.merged` as the
push it amounts to; a repository whose crew lands pulls all day carries its
forks along. A fork that followed silently holds the parent's commit byte for
byte, so its check is not run again on the copy; a merge into the fork's own
work is a new commit and is checked.

## The way in

A repository with forks, or one that is a fork, has a **Forks** tab in its
strip beside Issues and Pulls, with the count of forks under it. It opens the
family tree. A repository with neither has no tab: there is no family to
show. A fork's own page carries its following card first, above everything.

## The relationship, at rest

Every view of a fork reads its standing from git; nothing about it is stored.
`forkRelation(forge, fork, parent)` answers one of four states from three
plumbing questions inside the fork (the parent's objects are visible through
its alternates, so no fetch happens on a read):

| state      | means                                                       | behind | ahead |
| ---------- | ----------------------------------------------------------- | ------ | ----- |
| `synced`   | the copy nobody has touched, or an empty side               | 0      | 0     |
| `behind`   | nothing of its own; it can simply move                      | n      | 0     |
| `ahead`    | its own work; the parent has not moved                      | 0      | n     |
| `diverged` | both; `git merge-tree --write-tree` says whether they merge | n      | n     |

For `diverged`, `clean` is git's verdict and `conflicts` the files both sides
changed. That verdict is what decides the weight of what follows: a clean
merge is still mechanical; a conflict is a decision.

The card on a fork's home (`src/web/pages/following.ts`) says it in one
sentence — "3 behind and 2 of your own; one file needs a decision:
src/weapons.ts" — and offers exactly one thing to do. The forks page shows
each fork's standing as a badge. The JSON is
`GET /api/v1/repos/:owner/:name/following`.

## The family

`/:owner/:name/forks` draws the whole family as a tree, from the oldest
ancestor the viewer may see: who follows whom, each fork with its standing
against its own parent, and the page you came from marked "you are here".
It is nested lists, not a drawing, so the nesting a reader sees is the
nesting a screen reader announces and a phone never scrolls sideways to
follow it. `lineageOf` (`core/following.ts`) bounds the walk — sixty
repositories, six levels, thirty standings — and says when it cut something;
a fork the viewer may not read is simply not in their tree.

## Taking updates

`takeUpdates` (`actions/forks.ts`) is the one button for everything git can do
alone: a fast-forward when the fork is behind, a merge commit when it is
diverged and clean. The merge is plumbing in the bare repository —
`merge-tree`, `commit-tree`, a compare-and-swap `update-ref` — so there is no
clone, and it lands only if the fork's tip is still where it was read. The
result is a push like any other: previews, checks and the fork's own followers
all follow it. A conflict is refused with the files, never half-applied.

`POST /:owner/:name/following` with `do=take`, or
`POST /api/v1/repos/:owner/:name/following/take` (409 with `files` on a
conflict).

## Converging with the crew

When both sides changed the same file, the fork's crew makes the first draft
of the decision (`src/crew/converge.ts`):

1. The parent's default branch is staged inside the fork at
   `refs/following/<branch>`, so the builder's clone can fetch exactly what it
   is being asked to take without reading the parent.
2. One issue opens on the fork, "Take updates from owner/name", naming the
   files. It is the only issue a fork carries for this; asking again reports
   the one in hand.
3. One builder is picked the way any issue's builder is picked, and one run
   queues with reason `converge`. The brief tells it to merge the staged
   branch, resolve each conflict keeping what both sides meant, let this
   repository's direction decide where both cannot be kept, never drop the
   fork's own work, run the tests, push, and end its report with
   `Closes #N`.
4. The push opens a pull on the fork, as every crew push does. The pull lands
   the way pulls land there: on green when the fork runs on its own, after a
   look when it does not. Merging it closes the issue.

Nothing here moves the fork's default branch by itself.

`POST /:owner/:name/following` with `do=converge`, or
`POST /api/v1/repos/:owner/:name/following/converge` — 202 when a run is
queued, 200 when one is already in hand or the proposal is open, 409 when there
is nothing for the crew (in step, behind, or a clean merge: take it), no crew,
or the crew has parked it, 429 at the day's ceiling.

## On its own

A parent move that cannot fast-forward a fork appends `fork.diverged` on the
fork. The crew listens (`followDivergence`, subscribed by `startCrew`):

- autonomy `off` — nothing; the fork's page says what happened and offers both
  buttons.
- `assisted` — a conflict goes to the crew; a clean merge waits for the
  person's click.
- `autonomous` — a clean merge is taken as the person the fork acts as, and
  the check on the default branch says whether it was right; a conflict goes
  to the crew and its proposal lands on green.

Propagation is therefore a proposal, never a force: when you push, every
follower with work of its own gets a pull to look at, and every follower
without any simply moves.

## Mechanics that are rules

- The relationship is never cached; a wrong number would be worse than a slow
  one, and the questions are cheap.
- `takeUpdates` refuses a conflict; it does not try harder.
- One converge issue per fork per parent, found by its title.
- The staged ref is written before the issue opens, so a run never starts
  without the branch it was told to fetch.
- The converge run's assignee is set without the assignment event, so the
  run queues under its own reason and not as an ordinary assignment.
