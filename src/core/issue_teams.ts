/**
 * Cross-team work (#2681): the crew teams an issue names (at most two) and,
 * for a pull, the teams of the issues it closes and where each one's review
 * stands on the head. Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { crewWithRole } from "./agents.ts";
import { getIssue } from "./issues.ts";
import { closesFromBody } from "./pulls.ts";
import { listReviews, type Review, type ReviewState } from "./reviews.ts";
import { getTeam } from "./teams.ts";

export const TEAMS_MAX = 2;

export type IssueTeamsError = "too_many" | "no_such_team";

/** The slugs an issue names, in the order they were named. */
export function teamsOfIssue(db: Database, issueId: string): string[] {
  return db
    .query<{ team_slug: string }, [string]>(
      "SELECT team_slug FROM issue_team WHERE issue_id = ?1 ORDER BY rowid",
    )
    .all(issueId)
    .map((r) => r.team_slug);
}

/** Replace the teams an issue names: at most two, each a team that exists. */
export function setIssueTeams(
  db: Database,
  issueId: string,
  slugs: readonly string[],
): Result<string[], IssueTeamsError> {
  const unique = [...new Set(slugs)];
  if (unique.length > TEAMS_MAX) return err("too_many");
  for (const s of unique) if (!getTeam(db, s)) return err("no_such_team");
  db.transaction(() => {
    db.query("DELETE FROM issue_team WHERE issue_id = ?1").run(issueId);
    for (const s of unique)
      db.query("INSERT INTO issue_team (issue_id, team_slug) VALUES (?1, ?2)").run(issueId, s);
  })();
  return ok(unique);
}

/** The teams a pull must be read by: those named by the issues its body closes, at most two. */
export function teamsOfPull(
  db: Database,
  pull: { repoId: string; body: string },
): string[] {
  const out: string[] = [];
  for (const n of closesFromBody(pull.body)) {
    const issue = getIssue(db, pull.repoId, n);
    if (!issue) continue;
    for (const s of teamsOfIssue(db, issue.id)) if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, TEAMS_MAX);
}

export interface TeamVerdict {
  readonly team: string;
  readonly name: string;
  /** The latest verdict by a member of the team; undefined while none has spoken. */
  readonly state: ReviewState | undefined;
  readonly by: string | undefined;
  /** Whether that verdict was passed on an older head. */
  readonly stale: boolean;
}

/** Where each named team's review stands: the newest verdict from any of its members. */
export function teamVerdicts(
  db: Database,
  pull: { id: string; repoId: string; body: string; headOid: string },
): TeamVerdict[] {
  // Each member's newest verdict that is not a plain comment: an approval
  // followed by a comment still stands.
  const newest = new Map<string, Review>();
  for (const r of listReviews(db, pull.id))
    if (r.originAuthor === null && r.state !== "commented") newest.set(r.authorId, r);
  const latest = [...newest.values()];
  return teamsOfPull(db, pull).map((slug) => {
    const team = getTeam(db, slug)!;
    const mine = latest
      .filter((r) => team.members.includes(r.authorId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const fresh = mine.find((r) => r.commitOid === pull.headOid) ?? mine[0];
    return {
      team: slug,
      name: team.name,
      state: fresh?.state,
      by: fresh?.authorName,
      stale: fresh !== undefined && fresh.commitOid !== pull.headOid,
    };
  });
}

/** Whether every named team has a current verdict on the head (vacuously true with no teams). */
export const teamsAnswered = (verdicts: readonly TeamVerdict[]): boolean =>
  verdicts.every((v) => v.state !== undefined && !v.stale);

/**
 * The named teams that still hold the pull: each has a crew reviewer on the
 * pull's repository and no current approval on its head. A stale approval,
 * or a newer verdict that is not an approval, holds; a team with nobody to
 * ask does not, matching the review's lapse rule (docs/OPERATING.md).
 * `mergePull` refuses `team_review_required` while it is non-empty (#10080).
 */
export function teamsHolding(
  db: Database,
  pull: { id: string; repoId: string; body: string; headOid: string },
): TeamVerdict[] {
  const verdicts = teamVerdicts(db, pull);
  if (verdicts.length === 0) return [];
  const reviewers = new Set(
    (crewWithRole(db, [pull.repoId], "reviewer").get(pull.repoId) ?? []).map((a) => a.user.id),
  );
  return verdicts.filter((v) => {
    const askable = getTeam(db, v.team)!.members.some((m) => reviewers.has(m));
    return askable && !(v.state === "approved" && !v.stale);
  });
}
