/**
 * The rows behind ids `selection.ts` selected: ids in, plain records out,
 * in the order the ids came. Reads nothing the selection did not already
 * clear for the viewer — it never widens, it only fills in columns.
 */

import type { Database } from "bun:sqlite";
import type { User } from "../core/users.ts";
import { parseQuery, selectRows, type FleetKind } from "./selection.ts";

export type Cell = string | number;
export type FleetRow = Readonly<Record<string, Cell>>;

const SQL: Record<FleetKind, string> = {
  repo: `SELECT repo.id AS id, user.username || '/' || repo.name AS repo,
            repo.visibility AS visibility, repo.autonomy AS autonomy,
            COALESCE(app.access, 'none') AS app
         FROM repo JOIN user ON user.id = repo.owner_id
         LEFT JOIN app ON app.repo_id = repo.id
         WHERE repo.id IN (SELECT value FROM json_each(?1))`,
  run: `SELECT run.id AS id, user.username || '/' || repo.name AS repo,
           run.kind AS kind, COALESCE(actor.username, '') AS agent,
           run.state AS state, run.cost_usd AS cost, run.created_at AS created
        FROM run JOIN repo ON repo.id = run.repo_id
        JOIN user ON user.id = repo.owner_id
        LEFT JOIN user AS actor ON actor.id = run.actor_id
        WHERE run.id IN (SELECT value FROM json_each(?1))`,
  issue: `SELECT issue.id AS id, user.username || '/' || repo.name AS repo,
             issue.number AS number, issue.title AS title, issue.state AS state,
             COALESCE(who.username, '') AS assignee
          FROM issue JOIN repo ON repo.id = issue.repo_id
          JOIN user ON user.id = repo.owner_id
          LEFT JOIN user AS who ON who.id = issue.assignee_id
          WHERE issue.id IN (SELECT value FROM json_each(?1))`,
};

/** Each id's row, in the ids' order; an id gone since selection is dropped. */
export function fleetRows(
  db: Database,
  kind: FleetKind,
  ids: readonly string[],
): FleetRow[] {
  if (ids.length === 0) return [];
  const found = new Map(
    db
      .query<FleetRow & { id: string }, [string]>(SQL[kind])
      .all(JSON.stringify(ids))
      .map((r) => [r.id, r]),
  );
  return ids.flatMap((id) => {
    const row = found.get(id);
    return row === undefined ? [] : [row];
  });
}

/** What a query line shows: its kind and rows, or why it shows nothing. */
export type FleetView =
  | { readonly ok: true; readonly kind: FleetKind; readonly rows: FleetRow[] }
  | { readonly ok: false; readonly error: string };

/**
 * A query line read, selected for `viewer` (undefined: signed out) and
 * filled in — what the web page and the terminal screen both show.
 */
export function viewFleet(
  db: Database,
  viewer: User | undefined,
  line: string,
): FleetView {
  const parsed = parseQuery(line);
  if (!parsed.ok) return { ok: false, error: parsed.error.message };
  const ids = selectRows(db, viewer, parsed.value);
  if (!ids.ok) return { ok: false, error: ids.error.message };
  const kind = parsed.value.kind;
  return { ok: true, kind, rows: fleetRows(db, kind, ids.value) };
}
