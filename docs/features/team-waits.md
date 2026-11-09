# A team is told once that a pull waits on its review (#10164)

When a pull first becomes held by a named team (`teamsHolding`, `src/core/issue_teams.ts`), one `pull.team_waiting` event goes on the outbox. The team's members who can read the repository see "owner/repo#12 waits on Design's review" in the feed: web `/feed`, MCP `feed` and the terminal's Feed screen all read `candidatesFor` (`src/feed/items.ts`).

- **When it is said:** `announceTeamWaits` (`src/actions/team_waits.ts`) runs after a local pull opens, after a review is recorded, and when `nameTeams` names teams on an issue that open pulls close (at most the 50 newest open pulls whose body mentions `#N`). It compares with the newest `pull.team_waiting` / `pull.team_answered` for that pull and team, in one read on the kind index, so a held pull is never told twice.
- **When it ends:** the team's current approval on the head stops the hold; `pull.team_answered` closes the wait (never a feed post), so a later hold is news again.
- **Who is told:** both kinds have the `team` audience (`src/core/event_audience.ts`): only active members of `payload.team`, on every surface that lists events (the feed, `/:owner/:name/events`, the API and MCP `events`, the event streams and the activity rail). Not the repository's other readers, admins included.
- **Who can read:** the feed's own window is cut by owner and org access; a team member who reads a private repository by being on its crew gets the wait too (`listTeamEventsFor` then `canRead`, the check the pull's page asks).
- **Not announced:** a push that makes an old approval stale, and pulls opened through a mirror's origin.
- **Try it:** name a team on an issue, open a pull that says `Closes #N`, and open `/feed` as a member of that team.
- Tests: `test/feed-team-waits.test.ts`.
