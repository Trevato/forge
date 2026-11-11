# Planning: dependencies, the map, and what is ready

An issue can wait for another issue. That one fact, kept as one row per
edge in the forge's own tables, is the whole planning model: the map draws
it, the ready list reads it, the crew's planner writes it, and nothing else
remembers a plan.

## The edge

`#5 waits for #3` is a dependency. It lives in `issue_dependency`, both
issues in the same repository, and it is refused when it would close a
loop — a plan with a cycle has no first step. Anyone who can write the
repository, or is on its crew, may link and unlink; a planner agent's whole
job is to open issues and link them, so crew membership is enough here
where it is not for assigning (which spends money) or merging (a person's
call).

On the issue page, **Depends on** says _Waits for 2, 1 still open_ and
_Holds up 3_, with each issue linked and a field to add one. The terminal's
issue screen shows the same line, `Waits for #12, #15 · Holds up #20`, when
there is any, and a click on a number opens that issue. There a writer
presses `w` and types a number: a new one is linked, and one it already
waits for asks a confirm, then is unlinked. A refusal reads in
`dependencyWords`' sentences, as MCP `wait_for` says it. The page, the
terminal and `wait_for` all go through `linkIssue` and `unlinkIssue`
(`src/actions/dependencies.ts`). Over the API:

```
GET    /api/v1/repos/:owner/:name/issues/:n/dependencies   → { blockedBy, blocks }
POST   /api/v1/repos/:owner/:name/issues/:n/dependencies   { "blockedBy": m }
DELETE /api/v1/repos/:owner/:name/issues/:n/dependencies/:m
POST   /api/v1/repos/:owner/:name/issues/:n/dependencies/:m/confirm
```

A refused link says why: `self`, `cycle`, `cross_repo`, `not_an_issue`.
Linking is an event (`issue.blocked`, `issue.unblocked`) like any other
change, so hooks and the crew see it.

## The map

`/:owner/:name/map` draws the repository's open issues, laid out by what
waits for what. Closed issues are not drawn unless the page is asked for
`?done=1` ("Show done" beside the counts; "Open only" returns). Ready now,
Blocked on, the critical path, the marks, the counts and the pillar rows are
still computed on the whole graph, so a closed blocker still frees what it
held. The layout cache keys on the graph drawn, so each filter has its own. Each issue is a card one
level below everything it is blocked by, so the top edge is what is ready
now. Within a level, cards are ordered to keep the curves short and
uncrossed: a barycenter pass sorts each level by where its blockers sit,
then by where its dependents sit, and a transposition pass swaps
neighbours wherever that draws fewer crossings. An edge that skips levels
is routed down the gutters between cards, never under one. Issues that
wait for nothing and hold nothing up stand apart below the chains, under
a rule, so a backlog of loose items never crowds the plan. The longest
chain of open issues runs in the accent, at the same weight as every other
edge: the least work that still has to happen one thing after another.

**What a card says.** Its title on at most two lines, who is on it when
someone is, and one word:

- _ready_ — open, and nothing open stands in front of it.
- _working_ — the crew has a run in flight on it; the card wears a soft
  accent ring. Nothing on the map animates on its own: an animation inside
  a large inline SVG repaints the whole drawing every frame.
- _blocked_ — open, waiting for something open.
- _deferred_ — put off on purpose, and never ready: it waits behind the
  Later gate, it is filed under Later, or only deferred work needs it. The
  card, the data (`deferredBecause`) and the issue's own page say which, in
  the same words: "behind the Later gate", "filed under Later", or "only
  deferred work needs it: #12 One interface", naming the deferred limbs
  above it. A dashed, quiet card.
- _waiting_ — an open pull would close it: proposed, not landed.
- _parked_ — the crew parked it twice since someone who directs the crew
  last spoke on it; a quiet warning tint. It is the planner's now (below).
- _done_ — closed, still on an edge; it recedes.

Working outranks waiting, waiting outranks parked, parked outranks deferred,
and the rest is what the graph says. Under the drawing, one line counts them.

**Fit, pan, zoom.** The drawing fits its container's width on load and
never overflows the page sideways. Drag pans it; ⌘ or Ctrl and scroll (a
trackpad pinch, or two fingers on a phone) zooms around the pointer; the
_fit_ button puts it back. Every card is a link to its issue, so the map
is read by keyboard too, and the view follows focus. The drawing is a
live region: a card turns to _working_, a pull lands, or a new issue
appears while the page is open, and the reader's pan and zoom survive the
swap.

Beside the drawing, the three lists the crew and a person both read:

- **Ready now** — open issues nothing open stands in front of, first the
  ones whose finishing frees the most, then the oldest.
- **Blocked on** — open issues holding others up, the widest blockage first,
  counted through everything that transitively waits.
- **Critical path** — the emphasised chain, in order.

And two weeks of the repository's open count drawn as a line over issues
closed per day drawn as bars. They share a chart and not an axis, because
a level and a flow are different units: the line says whether the plan is
converging, the bars say whether anything is moving.

## The roadmap

`/:owner/:name/map` opens on the roadmap (#10303), `?view=graph` is the
drawing. How to read it and where else it is: [docs/features/roadmap.md](features/roadmap.md).

The same three lists are data at `GET /api/v1/repos/:owner/:name/map`,
which is what an agent reads before it starts (`issues` and `edges` hold only open issues; `?done=1`, or `done: true` on MCP `map`, brings the closed ones back; `counts.done` always says how many) and what a repository in
autonomous mode reads to pick the next thing. Both carry where the crew
is: an issue with an agent run in flight is marked _working_ on the
drawing and listed under `working` in the data; every issue in the data
carries its `word`, and `counts` sums them. `parkedTwice` lists each issue
the crew handed to the planner — its number, title and every reason.

### The global map

`/map` is every app on one page, one lane each. Each repository the viewer
can see that has an open issue or a run in flight is a lane, headed by its
name (a link to its own map), how it runs itself — _off_, _assisted_ or
_autonomous_ — today's spend as a thin bar against the ceiling with the
numbers beside it when it is not off, who is working (their avatars), and
the same count line as the repository's map. The lane is the same drawing
as the repository's map, drawn at the widest lane's width so one scale and
one grid hold across every lane; nothing is ever drawn across lanes. A
lane with nothing in flight and no card that says _ready_ is idle: it
folds to its header, and opens on a click. The page is one live region,
and a reader's folds, pans and zooms survive its swaps. Repositories with
nothing to draw are left out; a forge with nothing to draw anywhere says
so in one sentence. It is reached from the user menu and the command
palette, and from the Apps card on either home. `GET /api/v1/map` is the
same, one entry per repository, each the repository's map data plus
`autonomy`, `spentTodayUsd`, `ceilingUsd`, `inFlight`, `workers` and
`idle`.

## Parked twice

An issue the crew parked twice since someone who may direct the crew last
spoke on it is struck out: the clock no longer dispatches it. A reader's
comment does not start the count again, and neither does the planner's. A
park is the crew's own note, written in the name of someone who directs
it or by one of the repository's agents; a comment that only reads like one
strikes nothing. A struck-out issue is not dropped. The second park says every reason on the issue, in the one
note, and hands it to the planner (`crew/parks.ts`):

- **The planner's next pass is owed it.** A hand-over newer than the last
  planning run asks the planner once — with a full map, and even when the
  planner declined the direction and no person has spoken. Its task lists
  _Parked twice: #n_ with every reason.
- **The planner leaves it in one of three states**: split (closed as
  `split` into its parts), replaced (a fresh issue, the old one closed as
  split into it with "replaced by #m"), or deferred (linked to wait for the
  Later gate — the open issue whose title starts _Later gate_, which the
  owner closes to let deferred work start — with the reasons in a comment).
  A planner closes an issue by exactly this grant, on an open issue the
  crew parked twice: `split`, only into open issues made since the
  hand-over, never the issue itself or the Later gate, so a closed or an
  old issue cannot stand in for a drop; and `dropped`, only when no
  person's ask stands in the issue: an agent wrote it, and it did not come
  from a split of a person's issue, however many splits ago
  (`standsForPerson`). What a person asked for is dropped by a person.
  Never `done`, never a pull, never a reopen, never on a mirror.
- **Writing an issue does not make it an agent's to close.** An author's
  say over their own issue is a person's. An agent closes an issue by
  landing a pull for it or by the grant above, and reopens none — so the
  issue a planner opened to replace a person's ask is not the planner's to
  close, and the ask cannot be lost that way (#724).
- **Until then it is listed**: on the board, above its regions, for
  whoever owns the app, with its reasons and a link to the issue; and under
  `parkedTwice` in the map's data and the MCP's `map`. A comment from the
  planner or a builder does not take it off. What does: it is closed, it
  waits for something open, someone takes it up (a run in flight, or an
  open pull that would close it), or a person says on it what to try.

## Planning by the crew

An agent's brief says how: open issues each small enough for one run, link
what waits for what, read the map. A planner that never builds — Atlas,
on this forge — turns a direction into a map that way; a builder that finds
a task too big for one run splits it into linked issues instead of leaving
half of it. Either way the plan is where everyone can see it, and closing
an issue is what frees the next.

## Pillars and the Later gate

A direction can name what the work is for. Each such _pillar_ is an open
umbrella issue whose title starts with its name — `P0 Trust: …` — and an
issue serves the pillar whose umbrella waits for it; nothing else records
it (`src/core/pillars.ts`). A title alone does not make one: the umbrella,
the gate and the Later umbrella count only when a person who writes the
repository opened them here — not an agent, not a reader, not an issue
imported from an origin — so on a public repository a stranger's "P0 …"
makes no pillar and their "Later gate: …" holds nothing. Work that serves no pillar is not dropped and
is not ready either: it waits behind the _Later gate_, the open issue whose
title starts `Later gate:`, opens with one sentence that says why it waits,
and stands under the `Later: …` umbrella where the repository keeps one.
The owner moves an item out by unlinking it from the gate, or opens them
all by closing the gate.

A plan says which it is for every issue. The planner plans through one
route, `POST /api/v1/repos/:owner/:name/plan` with `{ "issues": [...] }`
(`rw` scope; a crew member's run token may use it), which calls the same
action as the MCP `plan` tool (`openPlan`): the same items, the same
refusals, all or nothing. An item names its `pillar`, or is `later: true`
with `why`; one that says neither is refused with `no_pillar` and nothing is
opened, so the planner reads the refusal, names the pillar or defers the
item, and posts again. The answer is `{ opened, ready, held, later, gate }`. `held`
lists each opened issue that is ready but would not start now, as `{ key, number, by,
detail }`: `by` is one of the map's hold names (`HOLDS` in
`src/crew/held.ts`) and `detail` its sentence. The usual ones are `hot_file`
(a file on the issue's `Files:` line is hot, or an admin holds it); an open
pull cannot hold an issue opened a moment ago. The planner can rewrite
what is held in the same run. A repository with no umbrella issues has no pillars, and plans as it always
did.

**An issue opened outside a plan.** A builder that finds its task too big
for one run opens smaller issues one at a time and links them. Such a split
child serves its parent's pillar: when the parent serves one, the builder
makes that umbrella wait for the child as well (`POST …/issues/U/dependencies`
with `{"blockedBy": child}`). It does not choose a pillar of its own and is
never deferred by the builder; where the parent serves none, the child
serves none either. Only a plan names new purposes.

The umbrellas, the Later umbrella and the gate are the plan's own, not
work. None of them is ever _ready_, so the crew never picks one and the map
never lists one under _Ready now_; one with nothing open in front of it
reads _parked_, "the plan's own: a person closes it, the crew never picks
it". An agent does not close one, whatever access it holds, and a merged
pull does not either, whatever its body says it closes: a person who writes
the repository closes an umbrella when its pillar is done, and closing the
gate opens everything behind it.

Membership is direct: an issue the umbrella itself waits for. Under two
umbrellas an issue serves the first, and a pillar outranks _Later_, which
is what waits behind the gate or stands under the Later umbrella.
Umbrellas and the gate are the plan's furniture: one umbrella waiting for
another is an order between pillars, not membership.

**What a person sees** (#610). `core/pillars.ts` is the one reader of all
this; three surfaces show what it reads.

- **The label.** An issue carries the label of the pillar it serves —
  `Later` for deferred work — made the first time it is needed, and no
  other pillar's. `actions/pillars.ts` writes it where the edges change (a
  link or an unlink, a `plan`, a split, where each umbrella that waited for
  the whole now waits for its parts) and at boot for what was linked
  before. The label only says what the edges say: it is never read back,
  and one set by hand does not survive the next boot. That holds for a
  label the repository already had under a pillar's name: at boot it is
  taken off every issue that does not serve that pillar. A mirrored
  repository's labels are its origin's, so none is written there.
- **The map by pillar.** Beside the drawing, _By pillar_ lists each pillar
  and _Later_ — a link to its issues, the list narrowed to its label — with
  what is open, ready and blocked, then _no pillar_ with the issues that
  serve none, each a link, since they are the ones to file. In the data
  every issue carries `pillar` (null for none), `pillars` is the same
  rows, and `mergedByPillar` is `{ days: 7, counts: [{ pillar, merged }] }`:
  the pulls merged in the last 7 days, each counted under the pillar of the
  first issue it closes that serves one. Each pillar's count also carries
  `askToLive: {medianHours, slowest: {number, hours}}` (null, a dash on the
  page, when none merged has gone live): hours from that issue opening to the
  first production deploy whose commit contains the pull's merge, by
  `git merge-base --is-ancestor`, cached. The MCP's `map` and `milestones`
  answers carry it too, on each pillar's limb.
- **The board by pillar.** _Landed_ leads with the same seven days for
  each app that has pillars: every pillar and its count, zero or not, each
  a link to its issues.

## Milestones

How far each thing asked for is, read from the dependency tree
(`core/milestones.ts`); nothing is stored. A _milestone_ is an issue that
waits for others, and what is beneath it is everything it waits for,
directly or through others. The plan's furniture is beneath nothing: one
pillar's umbrella waiting for another is an order between pillars.

`/:owner/:name/milestones` is the plan as a handful of _limbs_ — the
pillars and Later, or, in a repository with no pillars, the issues that
wait for others and that nothing waits for. Each is one line with its
weight: done of total, open beneath it, how many are building, pulls merged
in the last 7 days, its last movement and, for whoever may see owner facts,
what it cost. The work counted is what is open and what closed as done;
dropped and split issues are neither.

`/:owner/:name/milestones/:number` is one milestone opened: who is building
what, what is blocked and on what, what merged this week, and a plain
estimate — the open issues at the pace of the last 7 days, or a sentence
saying there is no pace to estimate from. Under it, issues closed per day
over 14 UTC days as a sparkline and one line from the same numbers:
`on pace for <date>` (today plus the estimate's days), `no movement in 7
days`, or `done <date>` (the day the last issue closed); a deferred milestone
has no line. The terminal's milestone list shows the line for the limb under
the cursor, and the MCP gives `closedPerDay`, `paceDate` and `pace`. What it waits for directly shows
as limbs where a child brings a tree of its own, and as leaves where it
brings none (one that only waits for its siblings is a leaf in an order).
Leaves show only on the limb they are under, and each issue shows once:
what is under _Building now_ or _Blocked_ is not listed again under
_Issues_. Later's milestone counts what the map's Later row counts: what
the Later umbrella waits for, and what waits behind the gate whether or
not the umbrella waits for it.

A limb is flagged _a candidate to trim_ when it has open work, nothing
landed in 7 days and it has been here that long, or when it has eight or
more open issues and nobody building. Later is deferred on purpose and is
never flagged.

It is one tap away: each pillar in the map's _By pillar_ and in the board's
7-day line opens its milestone, the map names the page, and the issue page
of anything that waits for others says _see how far it is_. The same
numbers are data at `GET /api/v1/repos/:owner/:name/milestones` (the limbs
as `{ items, next_cursor }`, with `limit` and `cursor`) and
`…/milestones/:number`, and in the MCP's `milestones`: `building` is the
count on a limb and on a milestone alike, and `buildingNow` lists who is on
what. An agent's name and the spend are the owner's to see: a reader gets
"the crew" and no cost.
### Trimming at a limb

Whoever administers the repository acts on a whole limb from its milestone,
not on each leaf (#733). Each action is one fleet operation
(`docs/FLEET.md`): a preview that lists every row it writes and every
issue it takes along, nothing written until it is confirmed, a receipt, and
one undo.

- **Defer** files every open issue that is the limb's own for later, the
  limb first: out from under its pillar, under Later, behind the Later
  gate — one row for each, so nothing is put off that the preview did not
  show. (On a plan where every issue is linked under its pillar, moving the
  limb alone would leave its leaves ready.) What other work outside the
  limb still waits for stays pickable and is listed as staying; an
  umbrella's wait is membership, not need. Anything linked beneath a
  deferred issue afterwards follows by the graph's own rule — an open issue
  that only deferred work waits for is deferred too, and is never ready.
  An issue nothing waits for at all is not touched by the rule. Each
  deferred issue reads _deferred_ wherever it is shown, with why: on the
  map, in its data and the MCP's `map`, on its own page, and on the
  milestone.
- **Resume** is the reverse, leaves first: what was filed for later comes
  back under the pillar named, or under none; an issue of the limb that was
  not filed for later is left as it is.
- **Close as not doing** closes every open issue that is the limb's own,
  the limb included, as `dropped`, with the reason said on each. What other
  work outside the limb also waits for is not the limb's to close.
- **Raise** and **Lower** (#1064) move the limb one place among its
  siblings — the pillars and Later at the top, a milestone's limbs under
  it. The place is stored per group of siblings (`limb_place`), kept across
  a restart, and is the order the limbs are listed in; a limb never placed
  follows the placed ones, by number. The preview shows the new order and
  how the top of the ready list changes. Once a person has set an order in
  a repository, the crew's ready order follows it: an issue beneath a
  higher limb comes before one beneath a lower limb (beneath two limbs, the
  higher), after them come issues beneath no limb, and within a limb the
  order is the old one — what it frees, then age. Until then nothing about
  the ready order changes. It is one fleet row, the verb `place`; undo puts
  the place back. Through the API and the MCP `limb` tool (`action` raise or
  lower, `under` when the limb sits in several places), dry-run by default.
- **Re-plan** (#761) hands the limb to the planner to come back as fewer,
  larger pieces. The preview lists every open issue the planner will be
  given. Pressing it writes the hand-over (`limb_replan`, with the issues
  it was given) and owes the planner one pass, even with a full map, even
  after it declined the direction, and without waiting out the hour since
  its last pass. Its task names the limb and lists the issues. Until the
  planner has answered — a planning run begun after the hand-over has
  ended — the limb reads _With the planner_ on its milestone and the crew
  picks nothing beneath it (the `with_planner` hold). The planner may close
  an issue beneath it only as `split` into open issues made since the
  hand-over, as for a twice-parked issue; it may not drop one, and the
  hand-over grants nothing outside the limb. A person may **take it back**
  until a planning run has begun. Afterwards the milestone lists which old
  issue closed into which. Not a fleet operation: it writes no issue row,
  so there is no receipt to undo; taking it back is the undo.
  In the terminal, `p` on the limbs screen (Milestones in a repository)
  previews what the planner is given and hands the limb over on confirm; the
  row then reads _with the planner_, and `p` takes it back while allowed.
  Through the API and the MCP `limb` tool as `action` `replan` or
  `takeback`, dry-run by default (the dry run is the list of issues).

An umbrella or the gate is the plan's own and is not filed. A leaf beneath
a limb that is not deferred cannot be deferred alone: defer the limb. A
candidate to trim offers Defer first.

The same is `POST /api/v1/repos/:owner/:name/milestones/:number/limb`
`{ "action": "defer" | "resume" | "close" | "raise" | "lower" | "replan" | "takeback", "reason"?, "pillar"?, "under"?, "dryRun"? }`
and the MCP's `limb`, both a dry run unless `dryRun` is false. Applying and
undoing take an admin token of a person who administers the repository; an
agent may look and never apply.

### Watching a milestone

A person who is signed in presses **Watch** on a milestone, once (#732);
pressing it again stops. A watch is theirs alone: one row per person and
issue (`core/watches.ts`), no event, nobody else told. What it says is read
from the plan each time, as that person:

- **In the feed**, one item for each milestone they watch, and only when
  there is something new: how far it is and what merged since they last
  opened it from the feed, or began to watch. The item is renamed as the
  milestone moves, so it is one item however many pulls merge, and a
  dismissal holds only until the next one does. Muting the app does not
  mute it.
- **On the phone**, one line when it lands, with a link to the milestone,
  through the notify URL (`crew/notify.ts`). Landed means its issue closed
  as done, or the last open issue beneath it closed. Progress never pages,
  and neither does a milestone that was dropped or split: the feed says
  that it will not land as written.

A watch on a repository the person can no longer read says nothing, in the
feed or on the phone. An agent does not watch. The same is `PUT` and
`DELETE /api/v1/repos/:owner/:name/milestones/:number/watch` with a write
token, `watching` on the milestone's read, and the MCP's `watch`. On the
terminal's Milestones screen, `w` on a row watches or stops; a watched row
reads _watching_, and an agent is told only a person watches.

## A repository on its own

A repository has one setting for how much the crew does without being
asked, under **Settings → Autonomy**:

- **Off.** Every run starts because a person assigned, commented, or a
  check failed. The default.
- **Assisted.** Once a minute, for as many free slots as the repository
  allows, the top of the ready list is assigned to a builder. Every green
  pull waits for a person's look.
- **Autonomous.** The same, and a pull whose head has a passing check and
  a passing deploy lands as the person who turned autonomy on — with their
  review and check requirements still enforced inside the merge. Nothing
  about a green pull reaches a person: first, a pull that no longer merges
  because `main` moved under it sends its agent one run (`conflict`, naming
  the files) to merge `main` into the branch, one waiting at a time, up to
  the same limit a failing check has; then the green head goes to the
  crew's _reviewer_ (`review` run: the diff, the preview, the pictures the
  forge took), whose approval lands it and whose change request goes back
  to the builder as feedback; a crew with no reviewer lands it. With two
  reviewers, a change to sign-in, tokens, secrets, the sandbox or the HTTP
  edge goes to the one whose brief says it reads for security, and every
  other change to the other (`crew/review.ts`). Every green pull an agent
  wrote is sent this way in any repository with a reviewer, autonomous or
  not; a review run is `ok` when it posted a verdict, since a reviewer
  pushes nothing. A review that does not come back — the run ends without
  a verdict, or is still out after 20 minutes — is sent once more; after
  the second, or an hour green with no verdict however the runs went, the
  review has lapsed and the pull lands on green with a note saying so. A
  missing reviewer never holds a pull silently. An agent's verdict stands
  only while the agent is a reviewer on the crew, and the reviewer gets two
  rounds of changes on a pull — a round is a head it asked changes on;
  past them its request is advice, and the third request hands the pull
  to a person in one card summarising the three reviews (not parked, not
  closed; a person's approval lands it). A builder's run that answers a change
  request without pushing parks the pull. A review run never resumes an
  earlier session, and the same verdict sent twice on one head is one. Nothing waits for a
  person: a pull whose check stays red past its tries, or whose branch
  could not be brought up to date, is _parked_ — closed with the reason,
  its issue put back on the map unassigned with the same note — and the
  crew moves on. An approved pull is finished before anything starts: a
  slot freed goes first to an approved pull that no longer merges, then
  to a pull with changes requested, then to a new issue, and one whose
  two updates ended without a push is handed to the person who turned
  autonomy on — assigned to them, not closed (`crew/finishing.ts`; the
  tick line says `finishing="queued Q, in flight F, skipped S: <why>×k"`,
  or `finishing="0 candidates of N open"`; each skipped pull is logged
  once per reason as `finishing: skip pull=N why="…"`, and every open pull
  that is not a candidate as `finishing: drop pull=N why="…"`; it reads every
  open pull, not the newest fifty). The planner's next pass splits or rewrites a parked
  issue, and one parked twice is handed to the planner (below). The planner
  keeps a standing reserve of startable work — two issues per builder
  slot, never fewer than three — and is asked whenever fewer than that can
  start, not only when the map runs dry. It is told the direction is never
  finished: when what it names is built, it proposes the next increment,
  and a pass that leaves the reserve short says why on the direction. The reviewer
  gets two rounds of changes on a pull; the third hands the pull to a
  person. The only pause is the day's ceiling. A person
  steers by editing the direction and the map; the crew does the rest. When nothing is
  ready and nothing is in flight, the map has run dry: the planner is
  given the direction.

Everything it does, it does as that person, through the same actions they
would take by hand — an assignment, a merge — so every run and every
landing is credited and bounded exactly as theirs would be.

**The crew's roles.** An agent declares its roles in its own config, beside
its model and brief (Settings → Crew → the agent; `roles` on `/api/v1/agents`
and the `agent` MCP tool): any of planner, builder, reviewer, one or more.
A repository's team is three lists, Planners, Builders and Reviewers, each
picking only from agents that declare the role, with how many may work at
once beside it; a repository narrows what an agent declares and never widens
it, and there is no default to builder. `/migrate` and a new app offer
builders only, and a dispatch never hands an agent a job outside its seat:
an issue assigned to a planner gets one comment saying so. Each crew member
then holds one of its roles on the repository: a _builder_ takes what is ready; a _planner_
turns the direction into a map; a _reviewer_ is for the look-back. Which
builder takes an issue is one fixed-choice function: the issue's own
assignee when it is a builder here, else the builder with the least in
flight, then by name — the place a faster or wiser decider plugs in later.

**The direction** is one or two sentences on the settings page. When the
map runs dry the forge opens an issue titled _Direction: …_ that carries
it, assigns the planner, and the planner's brief says the rest: open
issues each small enough for one run, link what waits for what, assign
nobody, push nothing. The direction issue stays open, is never picked as
work. A pass that did not end well — a decline a person answered, a
failure — is not followed by another for twenty minutes; one that ended
well has no floor. Nor is it asked again with nothing new: when nobody but the planner
has spoken on the direction since its last pass began, and no issue has
been opened by anyone else or closed since that pass ended, the clock
skips it and records one `guard` decision by rule. A busy crew counts the
startable issues before it plans; full slots alone are not a short
reserve. Every tick line says `reserve=startable/target`
(`src/crew/reserve.ts`).

**What counts as done and as taken.** A pull that says _Closes #12_
closes #12 when it lands, as the person who landed it; that is what frees
the map, on any repository, autonomous or not. An open pull that closes an
issue means the issue is proposed, neither ready nor done, and the tick
leaves it alone. An issue a builder ran on and left without a pull is
stalled: running it again blind is the loop autonomy refuses, so the next
tick parks it in the crew's name — a note with whose run stalled it and the
run's last summary, the assignee cleared — and another builder may pick it;
the one that stalled it leaves it for the hour unless a person says what to
try. A second stall strikes it out and hands it to the planner with both
reasons, past the direction's day's planning cap: unsticking is not
planning. The tick line counts them as `unstuck=N` (`src/crew/stalls.ts`).
A person's comment on it is a feedback run like any other. On every tick, green pulls that have not landed — a check that
passed before autonomy was on — land, so nothing green waits on chance.

**What holds it.** The ceiling is dollars of agent spend per UTC day; at
the ceiling the crew stops picking until midnight, and nothing in flight is
cut. Slots are the builders' runs at once — the WIP limit — and a
repository never starts more than that, whatever the forge-wide concurrency
allows. A reviewer's pass over a pull and a planner's run on the direction
take no slot: they refill the map rather than work it, and they never keep
a builder from picking the next issue. The number a page shows is that
same count, so what the page says and what the loop gates on are one
thing. A failing check on an agent's pull goes back to the agent as ever,
and after the same bounded number of tries the crew stops and waits for a
person: autonomy re-queues nothing a person must decide. The map page says
how it stands: _Autonomous · $12.40 of $40 today · 1 of 2 slots_, and why
it is paused when it is.

## Relieving a hot file

A planner may write a `Relieves: <path>` line in an issue only for a change whose purpose is to cut what other pulls must touch in that file (a split, an extraction), and the path must also be on its `Files:` line. Such an issue is not held by that file being hot (three paths at most), but only one at a time per file: while an open pull or a run serves another issue that relieves the path, the second waits (`waits: <path> is already being relieved by #N`), and an admin's pin on the file still holds it. The line is read from any issue body and the author is not checked, on purpose: the exemption lifts only the hot-file count, never the other holds, it admits at most three paths that the issue also lists under `Files:`, and one relieving build per file bounds what a stray `Relieves:` can pile up.

## Holding a pull

A person who writes the repository can say "not this one yet" about any
open pull, with one line that says why (`src/core/holds.ts`,
`src/actions/holds.ts`). While the hold stands, no rule touches the pull:
it is not sent to the crew's reviewer, not landed on green or on an
approval, not brought up to date by the crew, and not parked (parking
would close it and hand its issue back to be built again). A person's own
merge still works; the hold is on the rules, not on people. One word that
ships many changes at once is the exception: a batch from the asks leaves
a held pull where it is and says who holds it and why, since whoever sent
the batch may never have seen the hold. They ship it from its own page, or
release it first. An agent cannot hold or release, on the crew or not,
and neither can a reader.

Releasing starts the review clock again: review is owed from when the head
went green or from when the pull was last let go, whichever is later, so a
pull held past the hour and then released goes to the reviewer like any
newly green one and is never landed as lapsed.

The hold shows on the change page and the pull's own page with who and
why, and on the map the issue the pull answers says _held_. It is set and
lifted from the change page, with `PUT` and `DELETE
/api/v1/repos/:owner/:name/pulls/:number/hold`, or with the MCP `hold`
tool, which plans unless told `dryRun: false`. A held pull asks nothing of
the person who holds it.

## The decider

Some of what the forge does is a decision, not a generation: which builder
takes a sentence, how big it is, what kind of ask it is; whether a red
check is the change's fault or the environment's; which option on a card a
careful owner would pick. Every one has the same shape — a state, a set of
questions each with fixed choices, a probability per choice out — and every
one has a rule that answers it today. `crew/decide.ts` is that shape, and a
**decider** is anything that answers it better.

With `TYPESAFE_API_KEY` set, TypeSafe's Jev is the decider: a System One
model that answers fixed-choice questions with calibrated probabilities in
well under a second and never generates text. The forge asks it through
`POST /v1/systemone` with the state as a record of named facts and each
question as a `choice` with `criteria` — the options, and what each means.
`TYPESAFE_MODEL` picks a model (`jev-latest` by default); `TYPESAFE_URL`
points elsewhere for a stand-in.

The rule is never gone. A decider that is absent, slow past its budget,
errors, or names a choice outside the options leaves the rule's answer in
place, and `by` says which answered. Nothing a decider says is acted on
outside the choices the forge wrote down, which is what makes its answers
safe to act on without a person.

Where it decides today:

- **Routing** (`crew/route.ts`): who takes what was told, its size (tiny,
  small, large) and kind (bug, feature, question, chore). Asked when a
  sentence is told in the studio and when a repository on its own picks
  from the map. An issue already assigned to a builder keeps its builder;
  the decider is not asked.
- **Which issue next** (`crew/autonomy.ts`, `nextOf`): when a repository
  on its own has more than one ready issue, the decider chooses among the
  first six with the direction in hand. The rule takes the top of the ready
  list, the critical path.
- **Landing** (`landIfGreen`): a green pull in an autonomous repository
  lands by rule, once its base merges cleanly and it does not cross the
  wall (`docs/CONTRACT.md`). Nobody is asked; the ledger keeps the landing
  as a `ship` by the rule, once per head, so the week's numbers add up.
  A pull lands once: the merge reads the pull's row, not the caller's
  copy, and a squash whose tree is the base's own commits nothing — the
  pull closes as merged into the commit that carried it, and main does
  not move (#2017).
- **Whose fault, and try again or stop** (`crew/dispatch.ts`,
  `judgeFailedCheck`): a failed check gets another automatic run by rule,
  up to the limit. The decider reads the failure, the log's tail and the
  count and answers both at once — whether another try is worth its money,
  and whether the change, the environment or the base branch is what
  failed. The cause is settled before anything is parked: an environmental
  failure runs the check again (below) whatever the verdict, so a flaky
  runner never throws a change away. Otherwise _stop_ waits for a person as
  a stopped ask, and the parked reason says which of the two it was.

**The ledger.** Each of these is written to the `decision` table
(`core/decisions.ts`): what the decider saw, what it answered and with what
probability, who answered (the decider or the rule), and later what came of
it — a landed pull, a retry's next check green or red, a picked issue
shipped. `GET /api/v1/repos/:owner/:name/decisions`
lists it with the week summed per kind. It is the value function's raw
material: whether the decider beats the rule is a query, not an opinion.

- **A red check** (`crew/dispatch.ts`): the `cause` half of the decision
  above — from the tail of the check's log, whether the change, the
  environment or the base branch failed. At 70% or better the
  environment's fault runs the check again, once per head commit, instead
  of the agent reworking a change that is fine or the pull being parked
  for someone else's bad luck. A second red on the same commit is real:
  the pull parks, saying the environment.

Every answer a decider gives is a log line — `decided by=typesafe ms=270
answers=builder=mason@0.99 size=tiny@0.58 …` — so what it said and how
long it took are always in the forge's log.

## Closing takes a reason

`PATCH …/issues/:n { "state": "closed", "reason": "done"|"dropped"|"split", "into": [m, …] }`.
No reason means done. Done frees what waited. Dropped or split closes the
issue but holds its dependents as _parked_, the map saying why ("#4 was
dropped"), until a writer relinks them or confirms the edge
(`POST …/dependencies/:m/confirm`, the page's "Still holds"); the crew may
not confirm its own plan. Split also moves the parent's blocked-by edges to
the issues named in `into` (a child that would make a loop is skipped), and
the parent waits for nothing. Reopening clears the reason. Closes that
predate reasons count as done.

## Plans need a nod

A repository setting, `plansNeedNod` (PATCH `/api/v1/repos/:owner/:name`,
admin only, never an agent), off by default: on, the planner's work waits for a nod
and is not opened until then. On, `POST …/plan` and the MCP
`plan` tool run every check as ever (`no_pillar`, loops, unknown keys) and
then store one proposal — title, why, the ordered issues with their
`blockedBy` — answering `proposed` with its id (HTTP 202). No issue is opened.
Off, the plan opens its linked issues all or none. A person's nod opens a
stored proposal: `approve` in `src/actions/proposals.ts`, from the inbox card
or the MCP `asks_proposal`.

## A business, as a map (#439)

Atlas turns a business described in words into apps, adapters and what
waits for what, dry-run first and opened through `openPlan` once: the API
(`POST …/atlas`) and the terminal's **Atlas plan**. How to use it:
[docs/features/atlas-plan.md](features/atlas-plan.md).
