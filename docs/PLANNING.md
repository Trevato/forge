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
