/**
 * "Which repos may this viewer see", as one SQL fragment.
 *
 * It lived inside `repos.ts` and was correct there. It moved here the moment
 * a second query needed it: the activity feed has to filter events by repo
 * visibility, and doing that in JavaScript means reading a page of events,
 * throwing most of them away, and showing the viewer a feed with holes in
 * it. Two copies of a visibility rule is exactly the shape invariant 6 warns
 * about — a protection kept by convention rather than by code — so there is
 * one copy and both queries import it.
 *
 * The predicate takes the viewer id as `?1`. An anonymous viewer sees public
 * repos and nothing else; a site admin sees everything.
 */

/**
 * The repo's owner is in good standing (#831). A suspended or removed
 * account's repositories are kept, and hidden: from every list, page and
 * route a reader has, until the owner of the forge restores the account.
 */
export const OWNER_STANDING = `NOT EXISTS (
  SELECT 1 FROM user AS held WHERE held.id = repo.owner_id
    AND (held.suspended_at IS NOT NULL OR held.removed_at IS NOT NULL))`;

/** What a signed-out reader may see. */
export const PUBLIC_VISIBLE = `(repo.visibility = 'public' AND ${OWNER_STANDING})`;

/** Repos `?1` may read, as a boolean expression over a `repo` row. */
export const REPO_VISIBLE = `(
  EXISTS (SELECT 1 FROM user AS me WHERE me.id = ?1 AND me.is_admin = 1)
  OR (${OWNER_STANDING} AND (
    repo.visibility = 'public'
    OR repo.owner_id = ?1
    OR repo.owner_id IN (
      SELECT team.org_id FROM team
      JOIN team_member ON team_member.team_id = team.id
      WHERE team_member.user_id = ?1)))
)`;

/**
 * Repos `?1` may write, as a boolean expression over a `repo` row — the SQL
 * twin of `canWrite`, for the lists that must answer "which of these can I
 * push to" for fifty rows without fifty permission checks. Ownership, site
 * admin, a team with write or admin in the owning org, or the crew grant.
 */
export const REPO_WRITABLE = `(
  repo.owner_id = ?1
  OR repo.owner_id IN (
    SELECT team.org_id FROM team
    JOIN team_member ON team_member.team_id = team.id
    WHERE team_member.user_id = ?1 AND team.permission IN ('write','admin'))
  OR repo.id IN (SELECT repo_crew.repo_id FROM repo_crew WHERE repo_crew.user_id = ?1)
  OR EXISTS (SELECT 1 FROM user AS me WHERE me.id = ?1 AND me.is_admin = 1)
)`;

/**
 * The predicate for a viewer who may or may not exist. An anonymous viewer
 * cannot own anything and cannot be on a team, so the general form would
 * already give the right answer — but it would also make SQLite plan four
 * subqueries to prove it, on the one path (the signed-out home page) that is
 * hit most often and cached least.
 */
export const repoVisible = (signedIn: boolean): string =>
  signedIn ? REPO_VISIBLE : PUBLIC_VISIBLE;
