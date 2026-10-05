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
_Holds up 3_, with each issue linked and a field to add one. Over the API:

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

`/:owner/:name/map` draws the repository's open issues, and any closed one
still on an edge, laid out by what waits for what. Each issue is a card one
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
- _waiting_ — an open pull would close it: proposed, not landed.
- _parked_ — the last word on it is the crew parking it; a quiet warning
  tint, for the planner's next pass.
- _done_ — closed, still on an edge; it recedes.

Working outranks waiting, waiting outranks parked, and the rest is what
the graph says. Under the drawing, one line counts them.

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

The same three lists are data at `GET /api/v1/repos/:owner/:name/map`,
which is what an agent reads before it starts and what a repository in
autonomous mode reads to pick the next thing. Both carry where the crew
is: an issue with an agent run in flight is marked _working_ on the
drawing and listed under `working` in the data; every issue in the data
carries its `word`, and `counts` sums them.

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

A plan says which it is for every issue. The planner's brief tells it to
link each issue it opens under its pillar or behind the gate, and the MCP
`plan` tool refuses an item that says neither. A repository with no
umbrella issues has no pillars, and plans as it always did.

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
  and one set by hand does not survive the next boot. A mirrored
  repository's labels are its origin's, so none is written there.
- **The map by pillar.** Beside the drawing, _By pillar_ lists each pillar
  and _Later_ — a link to its issues, the list narrowed to its label — with
  what is open, ready and blocked, then _no pillar_ with the issues that
  serve none, each a link, since they are the ones to file. In the data
  every issue carries `pillar` (null for none), `pillars` is the same
  rows, and `mergedByPillar` is `{ days: 7, counts: [{ pillar, merged }] }`:
  the pulls merged in the last 7 days, each counted under the pillar of the
  first issue it closes that serves one.
- **The board by pillar.** _Landed_ leads with the same seven days for
  each app that has pillars: every pillar and its count, zero or not, each
  a link to its issues.

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
  past them its request is advice. A builder's run that answers a change
  request without pushing parks the pull. A review run never resumes an
  earlier session, and the same verdict sent twice on one head is one. Nothing waits for a
  person: a pull whose check stays red past its tries, or whose branch
  could not be brought up to date, is _parked_ — closed with the reason,
  its issue put back on the map unassigned with the same note — and the
  crew moves on; the planner's next pass splits or rewrites a parked
  issue, and one parked twice is left to the direction. A dry map is
  planned again within twenty minutes, and the planner is told the
  direction is never finished: when what it names is built, it proposes
  the next increment and leaves at least three ready issues. The reviewer
  gets two rounds of changes on a pull; after that it lands and what is
  left becomes an issue. The only pause is the day's ceiling. A person
  steers by editing the direction and the map; the crew does the rest. When nothing is
  ready and nothing is in flight, the map has run dry: the planner is
  given the direction.

Everything it does, it does as that person, through the same actions they
would take by hand — an assignment, a merge — so every run and every
landing is credited and bounded exactly as theirs would be.

**The crew's roles.** Each crew member has a role on the repository, set
under **Settings → Crew**: a _builder_ takes what is ready; a _planner_
turns the direction into a map; a _reviewer_ is for the look-back. Which
builder takes an issue is one fixed-choice function: the issue's own
assignee when it is a builder here, else the builder with the least in
flight, then by name — the place a faster or wiser decider plugs in later.

**The direction** is one or two sentences on the settings page. When the
map runs dry the forge opens an issue titled _Direction: …_ that carries
it, assigns the planner, and the planner's brief says the rest: open
issues each small enough for one run, link what waits for what, assign
nobody, push nothing. The direction issue stays open, is never picked as
work, and the planner is not asked again for twenty minutes unless its run
ended.

**What counts as done and as taken.** A pull that says _Closes #12_
closes #12 when it lands, as the person who landed it; that is what frees
the map, on any repository, autonomous or not. An open pull that closes an
issue means the issue is proposed, neither ready nor done, and the tick
leaves it alone. An issue a builder ran on and left without a pull is
stalled: the clock never picks it again, because running it again blind is
the loop autonomy refuses. A person's comment on it is a feedback run like
any other. On every tick, green pulls that have not landed — a check that
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

## Holding a pull

A person who writes the repository can say "not this one yet" about any
open pull, with one line that says why (`src/core/holds.ts`,
`src/actions/holds.ts`). While the hold stands, no rule touches the pull:
it is not sent to the crew's reviewer, not landed on green or on an
approval, not brought up to date by the crew, and not parked (parking
would close it and hand its issue back to be built again). A person's own
merge still works; the hold is on the rules, not on people. An agent cannot hold
or release, on the crew or not, and neither can a reader.

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
