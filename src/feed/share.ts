/**
 * The one share verb: `share(item, to?)`. It says who needs to know and
 * tells them the way that fits — an agent is steered or told through the
 * routes that already exist, a person gets the item boosted in their feed
 * with a "shared by" reason. Three rules keep it from being noise:
 * a share never widens access (the recipient must read the repository and
 * be able to see that very item, by the feed's own sources); an item goes
 * to a recipient once; and a person's day has a budget, past which shares
 * wait in a queue and decay (`core/shares.ts`).
 *
 * With no target the route is the app's crew and owners, and only when
 * there is none of those, the people who pinned the app (inside the org,
 * when an org owns it). A named target is always added.
 */

import type { App } from "../app.ts";
import { addCommentThrough } from "../actions/issues.ts";
import { tell } from "../actions/tell.ts";
import { listCrew } from "../core/agents.ts";
import { getIssue } from "../core/issues.ts";
import { mutedRepos, recordInteraction } from "../core/interactions.ts";
import { isOrgMember } from "../core/orgs.ts";
import { canRead, getRepoById } from "../core/repos.ts";
import {
  DAILY_BUDGET,
  addShare,
  deliveredToday,
  drainQueue,
  wasShared,
} from "../core/shares.ts";
import {
  getUserById,
  getUserByName,
  type User,
} from "../core/users.ts";
import { candidatesFor, type Candidate } from "./items.ts";

export const RECIPIENTS_MAX = 10;

export type Outcome =
  | "delivered"
  | "queued"
  | "steered"
  | "told"
  | "duplicate"
  | "skipped"
  | "unreachable";

export interface Sent {
  readonly to: string;
  readonly outcome: Outcome;
}

export type ShareError = "not_found" | "invalid_target";

/** Owners who need to know: the person, or an org's writers and admins. */
function ownersOf(app: App, ownerId: string): User[] {
  const owner = getUserById(app.db, ownerId);
  if (owner === undefined) return [];
  if (owner.kind !== "org") return [owner];
  return app.db
    .query<{ user_id: string }, [string]>(
      `SELECT DISTINCT team_member.user_id FROM team_member
       JOIN team ON team.id = team_member.team_id
       WHERE team.org_id = ?1 AND team.permission IN ('write','admin')`,
    )
    .all(ownerId)
    .map((r) => getUserById(app.db, r.user_id))
    .filter((u): u is User => u !== undefined);
}

function followersOf(app: App, repoId: string, ownerId: string): User[] {
  const org = getUserById(app.db, ownerId)?.kind === "org";
  return app.db
    .query<{ user_id: string }, [string]>(
      "SELECT user_id FROM pin WHERE repo_id = ?1",
    )
    .all(repoId)
    .filter((r) => !org || isOrgMember(app.db, ownerId, r.user_id))
    .map((r) => getUserById(app.db, r.user_id))
    .filter((u): u is User => u !== undefined);
}

const words = (c: Candidate): string => c.what.replace(/\s+/g, " ").slice(0, 200);

export async function share(
  app: App,
  sender: User,
  itemId: string,
  to: readonly string[] = [],
  now = Date.now(),
): Promise<
  | { ok: true; value: { sent: Sent[]; item: Candidate } }
  | { ok: false; error: ShareError }
> {
  const db = app.db;
  // The sender must see the item, by the same sources the feed reads.
  const item = candidatesFor(db, sender, now).find((c) => c.id === itemId);
  const repo = item && getRepoById(db, item.repoId);
  if (!item || !repo || !canRead(db, repo, sender))
    return { ok: false, error: "not_found" };

  const named: (User | string)[] = [];
  for (const name of to) {
    const u = getUserByName(db, name);
    named.push(u && u.kind !== "org" ? u : name);
  }
  let routed: User[] = [];
  if (named.length === 0) {
    const first = [
      ...listCrew(db, repo.id).map((a) => a.user),
      ...ownersOf(app, repo.ownerId),
    ];
    routed = first.some((u) => u.id !== sender.id)
      ? first
      : followersOf(app, repo.id, repo.ownerId);
  }
  const wanted: (User | string)[] = [...named, ...routed];

  const seen = new Set<string>([sender.id]);
  const sent: Sent[] = [];
  const muted = new Map<string, Set<string>>();
  for (const w of wanted) {
    if (sent.length >= RECIPIENTS_MAX) break;
    if (typeof w === "string") {
      // No such person and not yours to know about look the same.
      sent.push({ to: w.slice(0, 40), outcome: "unreachable" });
      continue;
    }
    if (seen.has(w.id)) continue;
    seen.add(w.id);
    const mine = (outcome: Outcome): void => {
      sent.push({ to: w.username, outcome });
    };
    // No widening: the recipient reads the repository and sees this item.
    if (
      !canRead(db, repo, w) ||
      !candidatesFor(db, w, now).some((c) => c.id === item.id)
    ) {
      mine("unreachable");
      continue;
    }
    if (wasShared(db, item.id, w.id)) {
      mine("duplicate");
      continue;
    }
    if (w.kind === "agent") {
      mine(await steer(app, sender, w, repo, item));
      continue;
    }
    if (!muted.has(w.id)) muted.set(w.id, mutedRepos(db, w.id));
    if (muted.get(w.id)!.has(repo.id)) {
      mine("skipped");
      continue;
    }
    drainQueue(db, w.id, now);
    const room = deliveredToday(db, w.id, now) < DAILY_BUDGET;
    addShare(db, {
      itemId: item.id,
      senderId: sender.id,
      recipientId: w.id,
      repoId: repo.id,
      kind: item.kind,
      link: item.link,
      what: words(item),
      state: room ? "delivered" : "queued",
      at: now,
    });
    mine(room ? "delivered" : "queued");
  }
  if (sent.some((s) => s.outcome !== "unreachable" && s.outcome !== "duplicate"))
    recordInteraction(db, {
      viewerId: sender.id,
      itemId: item.id,
      kind: "shared",
      repoId: repo.id,
      actorId: item.actorId,
      at: new Date(now).toISOString(),
    });
  return { ok: true, value: { sent, item } };
}

/**
 * An agent hears it the way it hears anything: said on the change when the
 * item is one (a builder at work takes it as its next step), told to the
 * crew otherwise. A sender who may not speak there is turned away.
 */
async function steer(
  app: App,
  sender: User,
  agent: User,
  repo: NonNullable<ReturnType<typeof getRepoById>>,
  item: Candidate,
): Promise<Outcome> {
  const text = `Shared by ${sender.username} with ${agent.username}: ${words(item)} (${item.link})`;
  const number = /\/changes\/(\d+)$/.exec(item.link)?.[1];
  const issue =
    number === undefined ? undefined : getIssue(app.db, repo.id, Number(number));
  if (issue !== undefined) {
    const said = await addCommentThrough(app, sender, repo, issue, text);
    if (said.ok) {
      markSent(app, item, agent, sender);
      return "steered";
    }
    return "unreachable";
  }
  const told = await tell(app, sender, repo, text);
  if (!told.ok) return "unreachable";
  markSent(app, item, agent, sender);
  return "told";
}

/** An agent has no feed; the row only keeps it from being steered twice. */
function markSent(app: App, item: Candidate, agent: User, sender: User): void {
  addShare(app.db, {
    itemId: item.id,
    senderId: sender.id,
    recipientId: agent.id,
    repoId: item.repoId,
    kind: item.kind,
    link: item.link,
    what: words(item),
    state: "delivered",
    at: Date.now(),
  });
}
