/**
 * Pinned forges (#8697): rows, and the one way their version and config move.
 * `recordChange` is the only writer of either; the schema trigger refuses an
 * UPDATE that skips it (migration 20261103090000). A pinned forge has no crew
 * and no automatic release, and the CHECKs keep it so.
 */

import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export interface Pinned {
  readonly id: string;
  readonly name: string;
  readonly target: string;
  readonly account: string;
  readonly app: string;
  readonly source: string;
  readonly version: string;
  readonly config: Record<string, string>;
  readonly remote: string;
  readonly volume: string;
  readonly address: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface Change {
  readonly id: number;
  readonly kind: "deploy" | "update" | "rollback";
  readonly fromVersion: string | null;
  readonly toVersion: string;
  readonly by: string;
  readonly at: string;
}

export const NAME = /^[a-z][a-z0-9-]{0,39}$/;
/** A full commit id or a release tag such as v1.4.2 — nothing a shell or git could read as a flag. */
export const VERSION = /^(?:[0-9a-f]{40}|v\d{1,4}\.\d{1,4}\.\d{1,4})$/;
export const APP = /^[a-z0-9][a-z0-9_-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/;
const SOURCE = /^https:\/\/[a-z0-9][a-z0-9.-]{0,100}(?:\/[A-Za-z0-9._~-]{1,100}){1,4}$/;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
// A value is written to a systemd EnvironmentFile on the machine: no quote,
// backslash, dollar, backtick or newline can reach it.
const VALUE = /^[A-Za-z0-9 _.,:\/@+=-]{0,512}$/;
const SECRETISH = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|API_?KEY|ACCESS_?KEY/;

export function validVersion(v: string): boolean {
  return VERSION.test(v);
}

export function validSource(s: string): boolean {
  return SOURCE.test(s) && !s.includes("..");
}

/** Config is plain, non-secret settings; a secret-looking name is refused so none lands in a row. */
export function checkConfig(raw: unknown): Result<Record<string, string>, string> {
  if (raw === undefined) return ok({});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return err("config is an object of NAME: value");
  const out: Record<string, string> = {};
  const entries = Object.entries(raw);
  if (entries.length > 40) return err("config holds at most 40 settings");
  for (const [k, v] of entries) {
    if (!KEY.test(k)) return err(`config name ${k.slice(0, 20)} is capitals, digits and underscores`);
    if (SECRETISH.test(k)) return err(`${k} looks like a secret; secrets are sealed in cloud accounts, never in config`);
    if (typeof v !== "string" || !VALUE.test(v)) return err(`config ${k} is plain text of letters, digits and . , : / @ + = - _`);
    out[k] = v;
  }
  return ok(Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1))));
}

interface Row {
  id: string; name: string; target: string; account: string; app: string; source: string;
  version: string; config: string; remote: string; volume: string; address: string; state: string; created_at: string;
}

const toPinned = (r: Row): Pinned => ({
  id: r.id, name: r.name, target: r.target, account: r.account, app: r.app, source: r.source,
  version: r.version, config: JSON.parse(r.config) as Record<string, string>,
  remote: r.remote, volume: r.volume, address: r.address, state: r.state, createdAt: r.created_at,
});

export const listPinned = (db: Database): Pinned[] =>
  db.query<Row, []>("SELECT * FROM pinned_forge ORDER BY created_at, id").all().map(toPinned);

export function getPinned(db: Database, name: string): Pinned | undefined {
  const r = db.query<Row, [string]>("SELECT * FROM pinned_forge WHERE name = ?1").get(name);
  return r ? toPinned(r) : undefined;
}

export function changesOf(db: Database, pinnedId: string): Change[] {
  return db
    .query<{ id: number; kind: Change["kind"]; from_version: string | null; to_version: string; by: string; at: string }, [string]>(
      "SELECT id, kind, from_version, to_version, by, at FROM pinned_change WHERE pinned_id = ?1 ORDER BY id DESC",
    )
    .all(pinnedId)
    .map((c) => ({ id: c.id, kind: c.kind, fromVersion: c.from_version, toVersion: c.to_version, by: c.by, at: c.at }));
}

export function insertPinned(
  db: Database,
  p: { name: string; target: string; account: string; app: string; source: string; version: string; config: Record<string, string> },
  by: string,
): Pinned {
  const at = new Date().toISOString();
  const pid = newId();
  const config = JSON.stringify(p.config);
  db.transaction(() => {
    const c = db
      .query("INSERT INTO pinned_change (pinned_id, kind, from_version, to_version, from_config, to_config, by, at) VALUES (?1, 'deploy', NULL, ?2, NULL, ?3, ?4, ?5)")
      .run(pid, p.version, config, by, at);
    db.query(
      "INSERT INTO pinned_forge (id, name, target, account, app, source, version, config, change_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).run(pid, p.name, p.target, p.account, p.app, p.source, p.version, config, Number(c.lastInsertRowid), at);
  })();
  return getPinned(db, p.name)!;
}

/**
 * The one explicit change: write who, when, from and to, then move the pin.
 * Returns the stored change. Rollback's target is the `from` of the latest
 * change, so it is always one action to the previous version.
 */
export function recordChange(
  db: Database,
  forge: Pinned,
  kind: "update" | "rollback",
  to: { version: string; config: Record<string, string> },
  by: string,
): Change {
  const at = new Date().toISOString();
  const toConfig = JSON.stringify(to.config);
  db.transaction(() => {
    const c = db
      .query("INSERT INTO pinned_change (pinned_id, kind, from_version, to_version, from_config, to_config, by, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .run(forge.id, kind, forge.version, to.version, JSON.stringify(forge.config), toConfig, by, at);
    db.query("UPDATE pinned_forge SET version = ?1, config = ?2, change_id = ?3 WHERE id = ?4").run(
      to.version, toConfig, Number(c.lastInsertRowid), forge.id,
    );
  })();
  return changesOf(db, forge.id)[0]!;
}

/** What a rollback would restore: the latest change's `from`, if it had one. */
export function previousOf(db: Database, forge: Pinned): { version: string; config: Record<string, string> } | undefined {
  const r = db
    .query<{ from_version: string | null; from_config: string | null }, [string]>(
      "SELECT from_version, from_config FROM pinned_change WHERE pinned_id = ?1 ORDER BY id DESC LIMIT 1",
    )
    .get(forge.id);
  return r?.from_version != null && r.from_config != null
    ? { version: r.from_version, config: JSON.parse(r.from_config) as Record<string, string> }
    : undefined;
}

/** Machine facts the target reports back; they never touch version or config. */
export function setRemote(db: Database, name: string, f: { remote?: string; volume?: string; address?: string; state?: string }): void {
  db.query("UPDATE pinned_forge SET remote = coalesce(?1, remote), volume = coalesce(?2, volume), address = coalesce(?3, address), state = coalesce(?4, state) WHERE name = ?5")
    .run(f.remote ?? null, f.volume ?? null, f.address ?? null, f.state ?? null, name);
}

/** The row of a deploy that never reached a droplet, so its name can be tried again; its recorded change stays as history. */
export function dropPinned(db: Database, name: string): void {
  db.query("DELETE FROM pinned_forge WHERE name = ?1 AND remote = '' AND state = 'failed'").run(name);
}

/** The port the forge listens on at its droplet: the config's PORT, else the forge's own default. */
export const portOf = (p: Pick<Pinned, "config">): string => {
  const n = Number(p.config["PORT"]);
  return /^\d{1,5}$/.test(p.config["PORT"] ?? "") && n >= 1 && n <= 65535 ? String(n) : "3000";
};

/** Where a pinned forge is served, once its droplet's address is known; empty before. */
export const urlOf = (p: Pick<Pinned, "address" | "config">): string => (p.address === "" ? "" : `http://${p.address}:${portOf(p)}/`);
