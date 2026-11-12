/**
 * Taking an agent's account (#10912): the person who opens the one-time
 * claim link the start call returned, signed in, takes it. The agent's
 * repositories move to a new organisation the person owns, and the agent
 * stays in it as a member with write; the account wakes if it slept and
 * its archived repositories are woken. The link is burnt in the one
 * statement that checks it, so of two people racing on it one wins. A
 * repository that will not move stays with the agent and is reported; when
 * none moves the link is given back.
 */
import type { App } from "../app.ts";
import { setSuspended } from "../core/accounts.ts";
import { addTeamMember, createOrg, createTeam } from "../core/orgs.ts";
import { listReposOwnedBy, moveArchived, type Repo } from "../core/repos.ts";
import { markClaimed, startByClaim } from "../core/starts.ts";
import { transferRepo } from "../core/transfer.ts";
import { getUserById, type User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type ClaimError = "not_found" | "claimed" | "not_a_person" | "failed";

export const CLAIM_WORDS: Readonly<Record<ClaimError, string>> = {
  not_found: "This claim link is not one this forge made.",
  claimed: "This link was already used: someone has taken the account.",
  not_a_person: "Only a person's account can take this.",
  failed: "The account could not be moved; nothing was kept. Try the link again.",
};

export interface ClaimView {
  readonly agent: string;
  readonly repos: readonly string[];
  readonly claimed: boolean;
}

/** What a link holds, for the page that offers it: nothing secret. */
export function viewClaim(app: App, claimToken: string): ClaimView | undefined {
  const row = startByClaim(app.db, claimToken);
  const agent = row === undefined ? undefined : getUserById(app.db, row.userId);
  if (row === undefined || agent === undefined) return undefined;
  return {
    agent: agent.username,
    repos: listReposOwnedBy(app.db, agent.id).map((r) => `${r.ownerName}/${r.name}`),
    claimed: row.claimedAt !== null,
  };
}

export async function claimStart(
  app: App,
  claimer: User | undefined,
  claimToken: string,
  now: Date = new Date(),
): Promise<Result<{ org: string; repos: string[]; stayed: string[] }, ClaimError>> {
  const row = startByClaim(app.db, claimToken);
  const agent = row === undefined ? undefined : getUserById(app.db, row.userId);
  if (row === undefined || agent === undefined) return err("not_found");
  if (row.claimedAt !== null) return err("claimed");
  if (claimer === undefined || claimer.kind !== "user" || claimer.id === agent.id) return err("not_a_person");
  if (!markClaimed(app.db, agent.id, claimer.id, now)) return err("claimed");

  let org = createOrg(app.db, `${agent.username}-team`, claimer.id);
  if (!org.ok && org.error === "name_taken")
    org = createOrg(app.db, `${agent.username}-team-${Date.now().toString(36)}`, claimer.id);
  const team = org.ok ? createTeam(app.db, org.value.id, "agents", "write") : undefined;
  if (!org.ok || team === undefined || !team.ok || !addTeamMember(app.db, team.value, agent.id)) {
    // Nothing moved yet: give the link back.
    app.db.query("UPDATE start_account SET claimed_at = NULL, claimed_by = NULL WHERE user_id = ?1").run(agent.id);
    return err("failed");
  }
  const moved: Repo[] = [];
  const stayed: string[] = [];
  for (const repo of listReposOwnedBy(app.db, agent.id)) {
    const done = await transferRepo(app.db, app.reposRoot, repo, org.value, claimer.id);
    if (done.ok) {
      moved.push(done.value);
      moveArchived(app.db, done.value.id, false);
    } else stayed.push(`${repo.ownerName}/${repo.name}`);
  }
  if (moved.length === 0 && stayed.length > 0) {
    // Nothing moved: give the link back.
    app.db.query("UPDATE start_account SET claimed_at = NULL, claimed_by = NULL WHERE user_id = ?1").run(agent.id);
    return err("failed");
  }
  setSuspended(app.db, agent.id, null);
  app.bus.append({
    kind: "start.claimed",
    actorId: claimer.id,
    payload: { agent: agent.username, org: org.value.username, repos: moved.length },
  });
  return ok({ org: org.value.username, repos: moved.map((r) => `${r.ownerName}/${r.name}`), stayed });
}
