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
```

A refused link says why: `self`, `cycle`, `cross_repo`, `not_an_issue`.
Linking is an event (`issue.blocked`, `issue.unblocked`) like any other
change, so hooks and the crew see it.

## The map

`/:owner/:name/map` draws the repository's open issues, and any closed one
still on an edge, laid out by what waits for what. Each issue sits one
column right of everything it is blocked by, so the left edge is what is
ready now. Within a column, issues are ordered by where their blockers sit,
which keeps the arrows short. Issues that wait for nothing and hold nothing
up stand apart below the chains, so a backlog of loose items never crowds
the plan. The longest chain of open issues is emphasised: the least work
that still has to happen one thing after another.

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
is: an issue with an agent run in flight is marked _working_ (or _queued_)
on the drawing, and listed under `working` in the data.

### The global map

`/map` is every app on one canvas. Each repository the viewer can see that
has an open issue or a run in flight is one lane, stacked, headed by its
name (a link to its own map), how it runs itself — _off_, _assisted_ or
_autonomous_, with today's spend against the ceiling when it is not off —
and how many runs are in flight. The lane is the same drawing as the
repository's map. Repositories with nothing to draw are left out; a forge
with nothing to draw anywhere says so in one sentence. It is reached from
the user menu and the command palette, and from the Apps card on either
home. `GET /api/v1/map` is the same, one entry per repository, each the
repository's map data plus `autonomy`, `spentTodayUsd` and `inFlight`.

## Planning by the crew

An agent's brief says how: open issues each small enough for one run, link
what waits for what, read the map. A planner that never builds — Atlas,
on this forge — turns a direction into a map that way; a builder that finds
a task too big for one run splits it into linked issues instead of leaving
half of it. Either way the plan is where everyone can see it, and closing
an issue is what frees the next.

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
  review and check requirements still enforced inside the merge. When
  nothing is ready and nothing is in flight, the map has run dry: the
  planner is given the direction.

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
work, and the planner is not asked again for six hours unless its run
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
cut. Slots are runs at once — the WIP limit — and a repository never
starts more than that, whatever the forge-wide concurrency allows. A
failing check on an agent's pull goes back to the agent as ever, and after
the same bounded number of tries the crew stops and waits for a person:
autonomy re-queues nothing a person must decide. The map page says how it
stands: _Autonomous · $12.40 of $40 today · 1 of 2 slots_, and why it is
paused when it is.

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
- **A red check** (`crew/dispatch.ts`): from the tail of the check's log,
  whether the change, the environment or the base branch failed. When it
  is the environment's fault, at 70% or better, the check runs again once
  instead of the agent reworking a change that is fine.
- **Cards** (`web/pages/studio.ts`): which option on an "asks you" card is
  likely right, so the card leads with it — _likely_, _probably_ or _maybe_
  beside the button, the probability on hover. The person still decides.

Every answer a decider gives is a log line — `decided by=typesafe ms=270
answers=builder=mason@0.99 size=tiny@0.58 …` — so what it said and how
long it took are always in the forge's log.
