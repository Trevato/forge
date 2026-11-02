/**
 * The sentences a person reads when a team member is added or removed. The
 * Teams page (`POST /:owner/-/teams/:team/add` and `/remove`) and the
 * terminal's Organization teams screen say them from here, so they read the
 * same on both.
 */

/** Why an add was refused, from `addTeamMember`'s error. */
export function addRefusal(error: string, username: string): string {
  return error === "no_such_user"
    ? `No account called ${username || "that"}.`
    : error === "agent_cannot_own"
      ? `${username} is an agent: an agent never administers an organization.`
      : "Could not add that member.";
}

/** What an add did: `added` false means they were already on the team. */
export function addedSays(added: boolean, username: string, team: string): string {
  return added ? `Added ${username} to ${team}.` : `${username} was already on ${team}.`;
}

/** Why a remove was refused, from `removeTeamMember`'s error. */
export function removeRefusal(error: string, username: string, org: string, team: string): string {
  return error === "no_such_user"
    ? `No account called ${username || "that"}.`
    : error === "last_owner"
      ? `${team} must keep at least one person who owns ${org}. Make someone else an owner first.`
      : "Could not remove that member.";
}

/** What a remove did: `removed` false means they were not on the team. */
export function removedSays(removed: boolean, username: string, team: string): string {
  return removed ? `Removed ${username} from ${team}.` : `${username} was not on ${team}.`;
}
