/**
 * Accept a code scanning finding (#9593): a person with write access says
 * why it may stand, and the reason, who and when are recorded on the
 * finding. An agent never accepts one: a finding that holds a release is a
 * person's to lift, as a merge is. The page and the API answer from here.
 */

import type { App } from "../app.ts";
import { getFinding, markAccepted } from "../checks/scan_store.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { isActive, type User } from "../core/users.ts";

export const REASON_MIN = 3;
export const REASON_MAX = 500;

export type Accepted = { ok: true } | { ok: false; status: 400 | 403 | 404 | 409; why: string };

export function acceptFinding(app: App, repo: Repo, user: User | undefined, id: number, rawReason: string): Accepted {
  if (user === undefined || user.kind !== "user" || !isActive(user) || !canWrite(app.db, repo, user))
    return { ok: false, status: 403, why: "Only a person with write access accepts a finding." };
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, status: 404, why: "No such finding." };
  const reason = rawReason.replace(/\s+/g, " ").trim();
  if (reason.length < REASON_MIN || reason.length > REASON_MAX)
    return { ok: false, status: 400, why: `Say why it may stand, in ${REASON_MIN} to ${REASON_MAX} characters.` };
  const finding = getFinding(app.db, repo.id, id);
  if (finding === undefined) return { ok: false, status: 404, why: "No such finding." };
  if (!markAccepted(app.db, repo.id, id, user.id, reason)) return { ok: false, status: 409, why: "That finding is already accepted." };
  app.log.info("finding accepted", { repo: `${repo.ownerName}/${repo.name}`, finding: id, by: user.username });
  return { ok: true };
}
