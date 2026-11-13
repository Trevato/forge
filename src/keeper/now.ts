/**
 * `release now` (#11839): a person who may roll back asks the keeper to cut at
 * its next tick, outside the spacing, with a reason that stays on the release.
 * A hotfix does not wait for the half hour, the merge queue or a snapshot; it
 * still waits for a release in flight to be proven, for a hold, and for room
 * on the disk. One row, consumed by the cut; one that is not consumed within
 * {@link NOW_TTL_MS} lapses, so a request made when main had nothing new does
 * not cut a release a day later. One function behind the MCP tool and the
 * /releases card.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { mayRollBack } from "../release/gate.ts";
import { MAX_REASON, type OwnerHoldResult } from "./hold.ts";

export const NOW_TTL_MS = 60 * 60_000;

export interface NowRequest {
  readonly reason: string;
  readonly by: string;
  readonly at: string;
}

/** The standing request, if one has not lapsed. */
export function pendingNow(db: Database, at: number): NowRequest | undefined {
  const row = db.query<NowRequest, []>(`SELECT reason, by, at FROM keeper_now WHERE id = 1`).get();
  if (row === null || at - Date.parse(row.at) > NOW_TTL_MS) return undefined;
  return row;
}

export function clearNow(db: Database): void {
  db.query(`DELETE FROM keeper_now WHERE id = 1`).run();
}

export function askNow(db: Database, reason: string, by: string, at: number): NowRequest {
  const req = { reason, by, at: new Date(at).toISOString() };
  db.query(
    `INSERT INTO keeper_now (id, reason, by, at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, by = excluded.by, at = excluded.at`,
  ).run(req.reason, req.by, req.at);
  return req;
}

/** Ask for a release now. Refused for an agent and for anyone who may not roll back; a refusal writes nothing. */
export function releaseNowAs(app: App, user: User | undefined, reason: string): OwnerHoldResult<NowRequest> {
  if (user === undefined || !mayRollBack(app, user))
    return { ok: false, error: "forbidden", message: "cutting a release now is for a person who may write the forge's repository and administer it, not an agent" };
  const clean = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean === "" || clean.length > MAX_REASON) return { ok: false, error: "invalid", message: `reason is one line of 1 to ${MAX_REASON} characters` };
  const req = askNow(app.db, clean, user.username, Date.now());
  app.bus.append({ kind: "release.now_asked", actorId: user.id, payload: { reason: clean } });
  return { ok: true, value: req };
}
