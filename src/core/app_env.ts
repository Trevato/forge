/**
 * An app's environment — the rows. What an app reads from its environment
 * at start-up and the repository must not carry: an admin password, a
 * payment key. Values are sealed at rest (`kernel/secret.ts`), bound to
 * the app and the name, and never read back to a person: the only way a
 * plaintext leaves this module is `resolveAppEnv`, on the way into a
 * child process. Pure data: no authz, no events.
 */

import type { Database } from "bun:sqlite";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { open, seal } from "../kernel/secret.ts";

const log = createLog("app_env");

export interface AppEnvName {
  readonly name: string;
  readonly updatedAt: string;
}

/** `ADMIN_PASSWORD`, `STRIPE_SECRET_KEY`: the shell's own rule for a name. */
const NAME = /^[A-Z][A-Z0-9_]*$/;
export const NAME_MAX = 128;
export const VALUE_MAX = 64 * 1024;

/**
 * Names the forge sets itself, so an operator cannot take them from under
 * the app. `appEnv` (`apps/process.ts`) wins over these anyway; refusing
 * them here says so at the moment someone types one.
 */
const RESERVED = new Set([
  "PORT",
  "HOST",
  "NODE_ENV",
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "USER",
  "LOGNAME",
]);

export type AppEnvError = "invalid_name" | "reserved_name" | "invalid_value";

export function isAppEnvName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX && NAME.test(name);
}

export function isReservedAppEnvName(name: string): boolean {
  return RESERVED.has(name) || name.startsWith("FORGE_");
}

/** The names an app has set, alphabetical — never a value. */
export function listAppEnvNames(db: Database, appId: string): AppEnvName[] {
  return db
    .query<{ name: string; updated_at: string }, [string]>(
      "SELECT name, updated_at FROM app_env WHERE app_id = ?1 ORDER BY name",
    )
    .all(appId)
    .map((r) => ({ name: r.name, updatedAt: r.updated_at }));
}

/** Set a variable, replacing any value it had. */
export function setAppEnv(
  db: Database,
  dataDir: string,
  appId: string,
  name: string,
  value: string,
): Result<AppEnvName, AppEnvError> {
  if (!isAppEnvName(name)) return err("invalid_name");
  if (isReservedAppEnvName(name)) return err("reserved_name");
  // Empty would silently blank a secret; a NUL cannot cross execve.
  if (value === "" || value.length > VALUE_MAX || value.includes("\0"))
    return err("invalid_value");
  db.query(
    `INSERT INTO app_env (app_id, name, value_enc) VALUES (?1, ?2, ?3)
     ON CONFLICT(app_id, name) DO UPDATE SET
       value_enc = excluded.value_enc,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(appId, name, seal(dataDir, value, aad(appId, name)));
  const row = db
    .query<
      { updated_at: string },
      [string, string]
    >("SELECT updated_at FROM app_env WHERE app_id = ?1 AND name = ?2")
    .get(appId, name)!;
  return ok({ name, updatedAt: row.updated_at });
}

export function deleteAppEnv(
  db: Database,
  appId: string,
  name: string,
): boolean {
  return (
    db
      .query("DELETE FROM app_env WHERE app_id = ?1 AND name = ?2")
      .run(appId, name).changes > 0
  );
}

/**
 * Every variable, opened, for a process about to start. A row that will
 * not open — the key was rotated, or the row was tampered with — is left
 * out and logged by name, so one bad secret never stops a deploy the rest
 * of the app could still serve.
 */
export function resolveAppEnv(
  db: Database,
  dataDir: string,
  appId: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = db
    .query<
      { name: string; value_enc: string },
      [string]
    >("SELECT name, value_enc FROM app_env WHERE app_id = ?1 ORDER BY name")
    .all(appId);
  for (const row of rows) {
    const opened = open(dataDir, row.value_enc, aad(appId, row.name));
    if (opened.ok) out[row.name] = opened.value;
    else
      log.warn("app env value will not open; skipped", {
        app: appId,
        name: row.name,
        reason: opened.error,
      });
  }
  return out;
}

const aad = (appId: string, name: string): string => `${appId}:${name}`;
