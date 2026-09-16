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
autonomous mode reads to pick the next thing.

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

**What holds it.** The ceiling is dollars of agent spend per UTC day; at
the ceiling the crew stops picking until midnight, and nothing in flight is
cut. Slots are runs at once — the WIP limit — and a repository never
starts more than that, whatever the forge-wide concurrency allows. A
failing check on an agent's pull goes back to the agent as ever, and after
the same bounded number of tries the crew stops and waits for a person:
autonomy re-queues nothing a person must decide. The map page says how it
stands: _Autonomous · $12.40 of $40 today · 1 of 2 slots_, and why it is
paused when it is.
