/**
 * An app's environment — the rows. What an app reads from its environment
 * at start-up and the repository must not carry: an admin password, a
 * payment key. Values are sealed at rest (`kernel/secret.ts`), bound to
 * the app and the name, and never read back to a person: the only way a
 * plaintext leaves this module is `resolveAppEnv`, on the way into a
 * child process. Pure data: no authz, no events.
 *
 * A variable has a scope: `all` environments, `production` only, or
 * `preview` only. The same name may be set once per scope, and the narrower
 * scope wins where both apply — so previews can run on a test key while
 * production holds the live one, and neither ever sees the other's.
 */

import type { Database } from "bun:sqlite";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { open, seal } from "../kernel/secret.ts";

const log = createLog("app_env");

export type AppEnvScope = "all" | "production" | "preview";
export const APP_ENV_SCOPES: readonly AppEnvScope[] = [
  "all",
  "production",
  "preview",
];

export function isAppEnvScope(value: string): value is AppEnvScope {
  return (APP_ENV_SCOPES as readonly string[]).includes(value);
}

/** The scope an environment's own variables live under. */
export function scopeOfEnv(env: string): Exclude<AppEnvScope, "all"> {
  return env === "production" ? "production" : "preview";
}

export interface AppEnvName {
  readonly name: string;
  readonly scope: AppEnvScope;
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

export type AppEnvError =
  | "invalid_name"
  | "reserved_name"
  | "invalid_value"
  | "invalid_scope";

export function isAppEnvName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX && NAME.test(name);
}

export function isReservedAppEnvName(name: string): boolean {
  return RESERVED.has(name) || name.startsWith("FORGE_");
}

/** The names an app has set, alphabetical, widest scope first — never a value. */
export function listAppEnvNames(db: Database, appId: string): AppEnvName[] {
  return db
    .query<{ name: string; scope: string; updated_at: string }, [string]>(
      `SELECT name, scope, updated_at FROM app_env WHERE app_id = ?1
       ORDER BY name, CASE scope WHEN 'all' THEN 0 WHEN 'production' THEN 1 ELSE 2 END`,
    )
    .all(appId)
    .map((r) => ({
      name: r.name,
      scope: isAppEnvScope(r.scope) ? r.scope : "all",
      updatedAt: r.updated_at,
    }));
}

/** Set a variable in a scope, replacing any value it had there. */
export function setAppEnv(
  db: Database,
  dataDir: string,
  appId: string,
  name: string,
  value: string,
  scope: string = "all",
): Result<AppEnvName, AppEnvError> {
  if (!isAppEnvName(name)) return err("invalid_name");
  if (isReservedAppEnvName(name)) return err("reserved_name");
  if (!isAppEnvScope(scope)) return err("invalid_scope");
  // Empty would silently blank a secret; a NUL cannot cross execve.
  if (value === "" || value.length > VALUE_MAX || value.includes("\0"))
    return err("invalid_value");
  db.query(
    `INSERT INTO app_env (app_id, name, scope, value_enc) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(app_id, name, scope) DO UPDATE SET
       value_enc = excluded.value_enc,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(appId, name, scope, seal(dataDir, value, aad(appId, name)));
  const row = db
    .query<
      { updated_at: string },
      [string, string, string]
    >("SELECT updated_at FROM app_env WHERE app_id = ?1 AND name = ?2 AND scope = ?3")
    .get(appId, name, scope)!;
  return ok({ name, scope, updatedAt: row.updated_at });
}

/** Remove a variable from one scope; the others keep theirs. */
export function deleteAppEnv(
  db: Database,
  appId: string,
  name: string,
  scope: string = "all",
): boolean {
  return (
    db
      .query(
        "DELETE FROM app_env WHERE app_id = ?1 AND name = ?2 AND scope = ?3",
      )
      .run(appId, name, scope).changes > 0
  );
}

/**
 * Every variable an environment is to see, opened, for a process about to
 * start: what is set for `all`, then what is set for this environment's
 * own scope over it. A row that will not open — the key was rotated, or
 * the row was tampered with — is left out and logged by name, so one bad
 * secret never stops a deploy the rest of the app could still serve.
 */
export function resolveAppEnv(
  db: Database,
  dataDir: string,
  appId: string,
  env: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  const own = scopeOfEnv(env);
  const rows = db
    .query<
      { name: string; scope: string; value_enc: string },
      [string, string]
    >(
      `SELECT name, scope, value_enc FROM app_env
       WHERE app_id = ?1 AND scope IN ('all', ?2)
       ORDER BY name, CASE scope WHEN 'all' THEN 0 ELSE 1 END`,
    )
    .all(appId, own);
  for (const row of rows) {
    const opened = open(dataDir, row.value_enc, aad(appId, row.name));
    if (opened.ok) out[row.name] = opened.value;
    else
      log.warn("app env value will not open; skipped", {
        app: appId,
        name: row.name,
        scope: row.scope,
        reason: opened.error,
      });
  }
  return out;
}

const aad = (appId: string, name: string): string => `${appId}:${name}`;
