/**
 * Run now, in words: one call of a scheduled tool through `fireOne`, and what
 * to tell the person. The page and the terminal both say it through here, so
 * the sentences are one set.
 */

import type { Database } from "bun:sqlite";
import { lastFires, type How } from "../core/feature_fires.ts";
import { fireOne, type Reach } from "./feature_schedule.ts";

export const RUN_REFUSALS = {
  not_absorbed: "Absorb the app before running its tools.",
  not_scheduled: "That tool is not on the app's schedule.",
  asleep: "The app's production is not running; it is not woken for a run. Redeploy it first.",
  in_flight: "That tool is already running.",
} as const;

/** Call `tool` now and say how it went; `ok` is false for a refusal or a failed call. */
export async function runNow(db: Database, appId: string, tool: string, reach: Reach, how: How = "page"): Promise<{ ok: boolean; message: string }> {
  const fired = await fireOne(db, appId, tool, reach, Date.now, how);
  if (!fired.ok) return { ok: false, message: RUN_REFUSALS[fired.why] };
  const fire = lastFires(db, appId).find((f) => f.tool === tool);
  return fire?.ok === false ? { ok: false, message: `${tool} ran and failed: ${fire.error ?? "failed"}.` } : { ok: true, message: `${tool} ran.` };
}
