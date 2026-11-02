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

## Releases behind a parent forge

`FORGE_PARENT_URL` names the forge this one was spawned from. It must be
`https://` with no credentials or query (the forge refuses to boot otherwise).
The parent serves `/releases.json` as `{"releases":[{"name","url"}]}`, newest
first; the child reads it with a 3 s timeout, no redirects and a 256 KB cap,
caches it under `FORGE_APP_DATA` for 10 minutes, and says "N releases behind
<parent>" on a fork's following card, in the terminal's About card (`I`), and as `parentForge`
(`{host, behind, releases, fetchedAt, down}`, null when unset) in
`GET /api/v1/repos/:owner/:name/following` and the MCP `following` tool. A
page never waits for the parent: it shows the cached copy and refreshes in the
background, and a parent that is down or answering garbage leaves a "could not
be reached" with the age of the last copy. Unset, nothing is shown. Read only:
taking a release is not done here. This forge publishes its own
`/releases.json` (the version names, each linking to that document), so any
forge can be a parent. The terminal shows the count, not the release names.

## A frozen parent

A parent can itself be a mirror whose origin was disconnected — a detached
mirror (`docs/ORIGINS.md`, "When a token expires"). It is frozen: nothing
fetches into it, so it holds still while its upstream moves on. Measured
against it, a fork reads `synced` or `ahead` with `behind 0` — true of the
frozen copy and false of the world, which is how a fork came to read "ahead
813, behind 0" while upstream had moved (#1090). So against a frozen parent
the forge says neither the counts nor "up to date". The card says one honest
sentence instead —

> `trevato/forge-upstream` is frozen: its origin was disconnected on
> 2026-10-11, so what is here may be behind. Reconnect it.

— with the link to the parent's page, where its admin reconnects it in one
click; the badge, here and on the family tree, reads "parent frozen"; taking
updates with nothing to take says "Nothing new from … which is frozen"
rather than "Already up to date"; and the JSON carries
`parentFrozen: { detachedAt, frozenSince }` beside the counts so a client
can say the same. Once the parent is reconnected its sync moves it, the fork
follows as before, and the card goes back to its counts.

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

## The way back up

A fork's own work goes upstream in one press. When a fork is ahead of what
it follows, its following card offers **Propose upstream**: one pull opens
on the parent from the fork's default branch, its title the one landed
change's title, or `N changes from owner/fork` when there are several, its
body one line per change that landed here since the fork last proposed,
each linked — assembled from what already exists, so nothing waits on the
crew and nobody writes a description twice. A proposal already open is
shown, not doubled. When the parent is a mirror of an origin, the pull opens
on the origin itself (`docs/ORIGINS.md`, write-through): the fork's branch
is carried up first, and because its `main` cannot travel as `main` — that
would be a push onto the origin's own, not a proposal — it goes up under
the fork owner's name, `trevato/main` proposing into `main`. Landing it
there is landing it upstream.
`POST /api/v1/repos/:owner/:name/following/propose` is the same press over
the API.

A fork across forges (#1085): a spawned forge's `<org>/forge` follows its
parent's forge code in the mode the spawner chose, `tell-me` (default) or
`take-updates`; `/:owner/forge/following` shows the chain to the root and
the owner's **Sever**, which cuts the link and deletes nothing (the page
and the parent's `/family` say "follows nothing since …"). `docs/SPAWN.md`
has the shape. A **conflict** on **Take updates** is a tell for the crew:
the press opens (or finds) the converge issue naming the files in conflict,
assigned to a builder when the repository has one, and says why not when it
has none. The step is `takeOrTell` in `src/actions/follow.ts`, shared by the
page, `POST /api/v1/repos/:owner/:name/following/take` (409, naming the
converge issue), and the MCP `take_updates` tool, so the same press does the
same thing at every door.

## Ranked forks

`/:owner/:name/forks` and the terminal's forks screen (`f` in a repository)
list a repository's direct forks the same way, so the best of a fork tree
rises. Order: commits ahead of the parent's default branch (most first),
then fewest behind, then the newest tip commit. Each row reads `N ahead · M
behind` and when the fork last moved; a fork that is ahead has a **Compare**
button (on the page) to its `/pulls/new`, which proposes it to the parent.
Each fork's own forks are listed indented beneath it (one more level, on the
page and in the terminal alike); the forks below those are a count, `and N more
forks below`, linking on the page to that fork's forks page. A private fork is
never named or counted to someone who cannot read it.

In the terminal, a repository that follows another opens its forks screen
with `follows owner/name` and MCP `following`'s standing: `in step`, or the
state with `N ahead · M behind` (`parent frozen` behind a disconnected
origin). When the crew has a converge in hand, a second line says what it is
doing, in the words the following page uses; a fork that merges cleanly needs
no crew and has no such line. `enter` on the first opens the parent; on the
second, the converge issue. A parent the viewer may not read is never named
(`relationOf` hides it), and a repository that follows nothing shows neither
line.

On a fork behind a parent that is not frozen, a person who writes the fork is
offered `t`: a confirm says what will happen (`Fast-forward to owner/name: N
commits.`, a merge that keeps the fork's own commits, or the converge issue
when both sides changed the same files), and `y` calls `takeOrTell`, as the
following page and MCP `take_updates` do. The answer is the page's sentence
(`takeWords`); on a conflict the crew's line names the converge issue opened
or found, and `enter` opens it. A reader, an agent, a fork in step and a
repository that follows nothing are not offered `t`.

On a fork, a person who can write to it presses `u` on the forks screen. A
confirm says how many commits are ahead and which repository they would go to;
confirming calls `proposeUpstream`, as the following page's Propose button
does, and one pull opens on the parent. When a proposal is already open the
screen shows `#N is open on owner/name`, and `u` (or `enter` on that row)
opens that pull instead of making another. Readers and agents are not offered
`u`. Refusals are said in the following page's words (`actions/follow_words.ts`):
`This repository follows nothing.`, `Nothing here is ahead of owner/name.`,
`You need write access to propose from here.` and `owner/name did not take the
proposal: …`.

Forks with nothing ahead (or whose standing git cannot read) follow under
`N forks with nothing new`. At most 60 forks are ranked per view; past that
the page says `Ranking the first 60 of N forks`. A fork's standing is cached
by the pair of tips (`actions/forks.ts`), so a view of forks that have not
moved costs one `git log` per fork.

### Proposing to a parent forge

A spawned forge can offer its own change to the forge it came from. The
parent mints a proposal token for the child (above); the child keeps it in
`parent.json` as `"proposal": {"child": "kid", "token": "…"}` beside the
parent's address. On the child's `/<org>/forge/following` page a writer
presses **Propose to the parent forge** (or `POST …/following/propose-parent`):
the default branch is pushed to `child/<name>/<branch>-<tip>` at the parent,
and the pull opens there, titled by the change that landed last and naming it
(`org/forge#7`). Asking again for the same tip returns the pull already made.

The repository's admin changes how the forge follows its parent (`tell-me` or
`take-updates`) from the radio form on the same page, with `PATCH
/api/v1/forge/following {"mode"}`, with the MCP `follow_mode` tool, or by pressing `m` on the chain screen in the terminal. The
record in `parent.json` is rewritten atomically and a `forge.follow_mode` event
is appended. A non-admin is refused (403), a value outside the two modes is
422, and a severed forge is 409; each leaves `parent.json` untouched.

**Take the N new commits** (shown to the admin on `/<org>/forge/following` when
the parent is ahead, `POST /api/v1/repos/:owner/:name/following/take`, the MCP `take_updates`
tool, or `t` on the chain screen in the terminal) opens, or updates, the one `forge/take-updates`
pull whatever the follow mode, and never moves the default branch; a conflict
opens the converge issue instead, and nothing behind answers "Already up to date."

The page and `GET …/following/proposals` show each proposal as open, merged or
closed, read from the parent (the token may read back only pulls it opened) and
cached for a minute (only a signed-in viewer makes the parent get asked); a merged or closed one is final. A parent that does not
answer shows the last state with "parent unreachable" — never an error page.
In the terminal, the Chain card lists the proposals and `p` proposes. The MCP `propose_to_parent_forge` tool (writer only) proposes with the page's
words, and `forge_proposals` lists each proposal with its state and "parent
unreachable" where that applies. No dependency was added. Left out: a UI to paste
the token into `parent.json` (part 2 of #2182 covers minting and handing over).

Minting, listing and revoking go through one action
(`src/actions/proposal_tokens.ts`) at every door, and only a writer of the
repository may; anyone else is told "no such resource here, or it is not
visible to you", as the API says it. The secret is shown once, on minting.
The repository's settings page is one more door: a writer sees their proposal
tokens one to a line (child, origin, expires, last used) with Revoke, and a
form that mints one and shows its secret once; others see no section.

The check cell's memory is on the same page under **Check cell**, and in the terminal on a repository's About card (`I`, for an admin): the limit the machine enforces, read from `forge.json` on the default branch. When `check.limits.memory` asks for more than the machine's ceiling it shows both numbers and where the cut comes from (`FORGE_CELL_MEMORY_MAX_MIB`, else a share of the pod's memory); otherwise one number. The ceiling is read once and kept (`src/apps/check-memory.ts`).

- **MCP**: the `proposal_tokens` tool with `repo` and a `verb`: `mint`
  (`child`, `origin`, optionally `childRepo`), `list` (the ones you minted for
  the repository) or `revoke` (`id`).
- **Terminal**: `ctrl+k`, **Proposal tokens**, then the repository as
  `owner/name`. `n` mints (the child's name, then its https address) and shows
  the secret once on its own screen; `x` asks before it revokes the one under
  the cursor ("Revoke the token for <child>?", Keep selected): `y` revokes,
  `n`, esc or enter keeps it.
