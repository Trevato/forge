/**
 * A webhook that keeps failing, said once.
 *
 * Redeliver and pause exist, but nobody is told to use them. When a hook's
 * third delivery in a row ends `failed`, one `webhook.failing` event goes on
 * the bus for the repository's writers: once per streak, not per failure. A
 * delivery that ends `ok` ends the streak; the next three failures are a new
 * one. The streak is named by its oldest failed delivery (`since`), so a
 * redelivery that fails again, or a fourth failure, finds the event already
 * written and adds nothing.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";

/** Failed deliveries in a row that make a streak worth saying. */
export const STREAK = 3;

/** The longest reason the event carries. */
const REASON_MAX = 200;

/** The host a hook posts to; the whole address (often a secret) is not for writers. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "an unreadable address";
  }
}

/** Call after a delivery of this hook has ended `failed`. */
export function noteFailure(
  db: Database,
  bus: EventBus,
  webhookId: string,
  reason: string,
): void {
  const hook = db
    .query<{ repo_id: string; url: string }, [string]>(
      "SELECT repo_id, url FROM webhook WHERE id = ?1",
    )
    .get(webhookId);
  if (hook === null) return;
  // The streak is every failure since the newest success.
  const failed = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM webhook_delivery
        WHERE webhook_id = ?1 AND state = 'failed'
          AND id > COALESCE((SELECT MAX(id) FROM webhook_delivery
                              WHERE webhook_id = ?1 AND state = 'ok'), '')
        ORDER BY id`,
    )
    .all(webhookId);
  if (failed.length < STREAK) return;
  // Its oldest failure names it, however long it grows.
  const since = failed[0]!.id;
  const said = db
    .query(
      `SELECT 1 FROM event
        WHERE kind = 'webhook.failing' AND repo_id = ?1
          AND json_extract(payload, '$.webhookId') = ?2
          AND json_extract(payload, '$.since') = ?3 LIMIT 1`,
    )
    .get(hook.repo_id, webhookId, since);
  if (said !== null) return;
  bus.append({
    kind: "webhook.failing",
    repoId: hook.repo_id,
    payload: {
      webhookId,
      since,
      host: hostOf(hook.url),
      reason: reason.slice(0, REASON_MAX),
      failures: STREAK,
    },
  });
}
