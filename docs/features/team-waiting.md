# The pulls a crew team's review holds

A pull that closes an issue naming a crew team waits on that team's reviewer
until it approves the head (`teamsHolding` in `src/core/issue_teams.ts`, the
question the merge gate asks). `pullsWaitingOn` in `src/actions/issue_teams.ts`
lists them: oldest first (by when the pull was opened), at most 50, only pulls
the asker may read (repository access and sealed issues). One function serves
both doors.

- **MCP:** `org_teams { org, team, waiting: true }` (admin-scope token) answers
  `{ items: [{ repo, number, title, since }] }`. `team` is a crew-team slug or
  name; an unknown one is `not_found`.
- **Terminal:** Crew teams (forge admins), select a team, press `w`.

Crew teams belong to the whole forge, not to an organization, so `org` only has
to exist and does not narrow the answer. That is safe: what a caller sees is
decided by their read access to each repository, not by the org they name.
There is no web page for it.
