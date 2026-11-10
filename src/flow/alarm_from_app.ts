/**
 * The "person waiting" flow alarm (#10563): an issue a person sent from an
 * app that has sat unassigned for 15 minutes, or has had no crew comment for
 * an hour (counted from its arrival until the crew first speaks). It names
 * the issue, the one that has waited longest past its bound. Home and
 * /boards draw it.
 */

import type { Database } from "bun:sqlite";
import { waitingFromApp } from "../core/from_app.ts";

const MINUTE_MS = 60_000;
export const UNASSIGNED_AFTER_MS = 15 * MINUTE_MS;
export const UNANSWERED_AFTER_MS = 60 * MINUTE_MS;

export interface FromAppAlarm {
  readonly fired: boolean;
  readonly since?: string;
  readonly repo?: string;
  readonly number?: number;
  readonly says: string;
}

export function alarmFromApp(db: Database, now: Date): FromAppAlarm {
  let worst: { since: number; repo: string; number: number; why: string } | undefined;
  for (const w of waitingFromApp(db)) {
    const born = Date.parse(w.createdAt);
    const spoke = w.lastCrewAt === null ? born : Date.parse(w.lastCrewAt);
    const breaches: { since: number; why: string }[] = [];
    if (!w.assigned && now.getTime() - born >= UNASSIGNED_AFTER_MS)
      breaches.push({ since: born + UNASSIGNED_AFTER_MS, why: "sat unassigned for 15 minutes" });
    if (now.getTime() - spoke >= UNANSWERED_AFTER_MS)
      breaches.push({ since: spoke + UNANSWERED_AFTER_MS, why: "had no crew comment for an hour" });
    const first = breaches.sort((a, b) => a.since - b.since)[0];
    if (first !== undefined && (worst === undefined || first.since < worst.since))
      worst = { ...first, repo: w.repo, number: w.number };
  }
  if (worst === undefined) return { fired: false, says: "No person's note from an app is waiting." };
  return {
    fired: true,
    since: new Date(worst.since).toISOString(),
    repo: worst.repo,
    number: worst.number,
    says: `${worst.repo}#${worst.number}, sent by a person from an app, has ${worst.why}.`,
  };
}
