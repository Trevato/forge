/**
 * The Shield: how much an anonymous reader may spend, in one setting an admin
 * can change with no AI at hand (`docs/SECURITY-RUNBOOK.md`). Kept in
 * `forge_setting`, so a restart keeps it; every change also lands in
 * `forge_setting_change` and leaves a `shield.changed` event naming who.
 *
 * Read on every anonymous request, so it is a cached value: the database is
 * asked at most once in `FRESH_MS`, which also carries a change across to the
 * process beside this one during a release.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export const SHIELD_STATES = ["open", "ceiling", "signin"] as const;
export type ShieldState = (typeof SHIELD_STATES)[number];
export const SHIELD_DEFAULT: ShieldState = "ceiling";

const KEY = "shield";
const FRESH_MS = 5_000;

const isShieldState = (value: unknown): value is ShieldState => SHIELD_STATES.includes(value as ShieldState);

const cache = new WeakMap<Database, { state: ShieldState; at: number }>();

function stored(db: Database): ShieldState {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM forge_setting WHERE key = ?1").get(KEY);
  return isShieldState(row?.value) ? row.value : SHIELD_DEFAULT;
}

/** The Shield now. A failed read keeps the last known state: this must never fail a stranger's page. */
export function shieldState(app: App): ShieldState {
  const now = Date.now();
  const hit = cache.get(app.db);
  if (hit !== undefined && now - hit.at < FRESH_MS) return hit.state;
  let state = hit?.state ?? SHIELD_DEFAULT;
  try {
    state = stored(app.db);
  } catch {
    // Keep what was known, and ask again in a moment.
  }
  cache.set(app.db, { state, at: now });
  return state;
}

export interface ShieldChange {
  readonly from: ShieldState;
  readonly to: ShieldState;
  readonly by: string | null;
  readonly at: string;
}

/** The newest change, for "who set this" and the page's one-click undo. */
export function lastShieldChange(db: Database): ShieldChange | null {
  const row = db
    .query<{ from_value: string; to_value: string; username: string | null; at: string }, [string]>(
      `SELECT c.from_value, c.to_value, u.username, c.at
         FROM forge_setting_change c LEFT JOIN user u ON u.id = c.actor_id
        WHERE c.key = ?1 ORDER BY c.rowid DESC LIMIT 1`,
    )
    .get(KEY);
  if (row === null || !isShieldState(row.from_value) || !isShieldState(row.to_value)) return null;
  return { from: row.from_value, to: row.to_value, by: row.username, at: row.at };
}

/** A forge admin who is a person sets it; everyone else is told the door is not there. */
export function changeShield(
  app: App,
  actor: User | undefined,
  value: unknown,
): Result<{ from: ShieldState; to: ShieldState }, "not_found" | "no_such_state"> {
  if (actor?.isAdmin !== true || actor.kind === "agent") return err("not_found");
  if (!isShieldState(value)) return err("no_such_state");
  const from = stored(app.db);
  if (from === value) return ok({ from, to: value });
  const at = new Date().toISOString();
  app.db.transaction(() => {
    app.db
      .query(
        `INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(KEY, value, actor.id, at);
    app.db
      .query("INSERT INTO forge_setting_change (key, from_value, to_value, actor_id, at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(KEY, from, value, actor.id, at);
  })();
  cache.set(app.db, { state: value, at: Date.now() });
  app.bus.append({ kind: "shield.changed", actorId: actor.id, payload: { from, to: value } });
  return ok({ from, to: value });
}
