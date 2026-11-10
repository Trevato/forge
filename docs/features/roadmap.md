# The roadmap (#10303)

`/:owner/:name/map` opens on the roadmap for a repository that names pillars:
one sentence of pace (landed today and in 7 days, and when the current pillar
finishes, or that it has no date yet), a Needs you list that appears only when
something waits on a writer (a held pull, an umbrella with nothing open in
front of it), then the pillars in order, Later last. The current pillar is
open; the rest fold. A pillar shows Building, Up next, Waiting on a pull,
Blocked and Done this week.

A pillar's ETA is its open work over its 7-day merge rate (`mergedByPillar`);
with no merges there is no date. The drawing stays at `?view=graph` (and
`?done=1`); a repository without pillars still opens on the drawing. The page
is a live region, and an HttpOnly cookie of the last two visits marks what
moved since the previous one.

Reads follow the reader: a guest sees only what is public, sealed issues stay
sealed, and Needs you is shown to writers only.

## Where it is

- Page: `/:owner/:name/map`.
- API: `GET /api/v1/repos/:owner/:name/roadmap` (404 without pillars).
- MCP: `map` with `roadmap: true`.
- Terminal: the palette command "Roadmap of a repository" (`owner/name`);
  `j`/`k` scroll, `esc` closes. Same model, `src/web/roadmap.ts`.
