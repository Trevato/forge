# The pulls waiting on a crew team (#10162)

A team's card on Settings › Teams (`/settings/teams`) lists the open pulls
the team still holds, **oldest first, at most 50**: `owner/repo #n` linked to
the pull, then its title and age, in the same plain rows (`status-rows`) as
the rest of the settings pages. A team with nothing waiting says "Nothing is
waiting on this team." in one muted line.

- **Holds** means what the merge gate means (`teamsHolding`): the pull closes
  an issue naming the team, the team has a crew reviewer, and the pull has no
  current approval on its head.
- **Who reads:** both doors go through `readTeamQueue`
  (`src/actions/teams.ts`): a forge admin who is a person, and no one else.
  Pulls the reader may not read (private repositories, sealed reports) are
  left out before the cap applies.
- **Web:** server-rendered on the card; timed as the `queue` phase.
- **Terminal:** open "Crew teams", move to a team and press `w`
  (`src/tui/screens/teams.ts`); esc goes back. It reads `readTeamQueue`,
  so it is the page's list under the page's gate.
- **MCP:** `org_teams` with `waiting: true` still answers from its own
  `pullsWaitingOn` in `src/actions/issue_teams.ts` (#10173), under its
  own gate (an admin-scoped token) and without the index; it is not this list.
- **Query:** `pullsWaitingOn` (`src/core/team_queue.ts`) reads the issues that
  name the team (`issue_team_slug`), then walks open pulls in age order
  (`issue_open_pull_age`): no sort, and none of the walk for a team nothing
  names.
- Not live: the page refreshes on reload, not when a review lands.
