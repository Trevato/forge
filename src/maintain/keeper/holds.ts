/**
 * Wrongly held pulls (#7556): a hold the crew placed whose reason is gone is lifted: a check went
 * green on the head after the hold, or it is older than six hours. A person's hold is never read.
 */

import type { Database } from "bun:sqlite";
import { crewHoldsPlacedBefore, releaseHold } from "../../core/holds.ts";
import { checkOn, nameOf, type KPull } from "./pulls.ts";
import { note } from "./record.ts";

export const HOLD_MAX_MS = 6 * 3_600_000;

export function liftStale(db: Database, now: Date, pulls: readonly KPull[]): string[] {
  const byId = new Map(pulls.map((p) => [p.id, p]));
  const lifted: string[] = [];
  // `crewHoldsPlacedBefore` reads only holds an agent placed: a person's never reaches this loop.
  for (const hold of crewHoldsPlacedBefore(db, now.toISOString())) {
    const pull = byId.get(hold.pullId);
    if (pull === undefined) continue;
    const check = checkOn(db, pull);
    const green = check?.state === "ok" && check.finishedAt !== null && check.finishedAt > hold.heldAt;
    const old = now.getTime() - Date.parse(hold.heldAt) > HOLD_MAX_MS;
    if (!green && !old) continue;
    if (!releaseHold(db, hold.pullId, hold.heldBy)) continue;
    const reason = green ? "a check went green on its head after the hold" : "the hold was older than 6 hours";
    note(db, "keeper_release", pull.repoId, { pull: pull.id, number: pull.number, by: hold.heldByName, why: hold.why, reason });
    lifted.push(`${nameOf(pull)}: lifted ${hold.heldByName}'s hold (${reason})`);
  }
  return lifted;
}
