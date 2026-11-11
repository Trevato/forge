/**
 * Forge-level secrets — the rows. A credential the forge itself needs (a
 * DNS token to spawn forges, a bucket key for tofu state) has one home:
 * sealed here, at one of three scopes — the whole forge, an organization,
 * a repository — and never read back to a person. `resolveSecrets` is the
 * ONLY path a plaintext leaves, and every value it opens leaves an event
 * (who, which run, which name — never the value) and a `last_read_at`.
 *
 * Kept apart from `app_env` on purpose: an app's variables go into that
 * app's process; a secret goes only to whoever asks the resolver by name,
 * so a name here can shadow nothing there. Pure data apart from the event.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "./events.ts";
import { createLog } from "../kernel/log.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { open, seal } from "../kernel/secret.ts";

const log = createLog("secret_store");

export type SecretScope = "forge" | "org" | "repo";
export const SECRET_SCOPES: readonly SecretScope[] = ["forge", "org", "repo"];

export function isSecretScope(value: string): value is SecretScope {
  return (SECRET_SCOPES as readonly string[]).includes(value);
}

export interface SecretName {
  readonly name: string;
  readonly scope: SecretScope;
  readonly scopeId: string;
  readonly updatedAt: string;
  readonly lastReadAt: string | null;
}

export type SecretError = "invalid_name" | "invalid_value" | "invalid_scope";

const NAME = /^[A-Z][A-Z0-9_]*$/;
export const NAME_MAX = 128;
export const VALUE_MAX = 64 * 1024;

export function isSecretName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX && NAME.test(name);
}

const aad = (scope: SecretScope, name: string): string =>
  `secret:${scope}:${name}`;

/** A forge-wide secret has no owner; the others name an org or a repo by id. */
const ownerOf = (scope: SecretScope, scopeId: string): string =>
  scope === "forge" ? "" : scopeId;

interface Row {
  name: string;
  scope: string;
  scope_id: string;
  updated_at: string;
  last_read_at: string | null;
}

const toName = (r: Row): SecretName => ({
  name: r.name,
  scope: r.scope as SecretScope,
  scopeId: r.scope_id,
  updatedAt: r.updated_at,
  lastReadAt: r.last_read_at,
});

/** The names set at one scope, alphabetical — never a value. */
export function listSecretNames(
  db: Database,
  scope: SecretScope,
  scopeId = "",
): SecretName[] {
  return db
    .query<Row, [string, string]>(
      `SELECT name, scope, scope_id, updated_at, last_read_at FROM secret
       WHERE scope = ?1 AND scope_id = ?2 ORDER BY name`,
    )
    .all(scope, ownerOf(scope, scopeId))
    .map(toName);
}

/** Set a secret at a scope, replacing any value it had there. */
export function setSecret(
  db: Database,
  dataDir: string,
  scope: string,
  scopeId: string,
  name: string,
  value: string,
): Result<SecretName, SecretError> {
  if (!isSecretScope(scope)) return err("invalid_scope");
  if (!isSecretName(name)) return err("invalid_name");
  if (scope !== "forge" && scopeId === "") return err("invalid_scope");
  // Empty would silently blank a credential.
  if (value === "" || value.length > VALUE_MAX || value.includes("\0"))
    return err("invalid_value");
  const owner = ownerOf(scope, scopeId);
  db.query(
    `INSERT INTO secret (name, scope, scope_id, value_enc) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(name, scope, scope_id) DO UPDATE SET
       value_enc = excluded.value_enc,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(name, scope, owner, seal(dataDir, value, aad(scope, name)));
  const row = db
    .query<Row, [string, string, string]>(
      "SELECT name, scope, scope_id, updated_at, last_read_at FROM secret WHERE name = ?1 AND scope = ?2 AND scope_id = ?3",
    )
    .get(name, scope, owner)!;
  return ok(toName(row));
}

/** Remove a secret from one scope; the wider ones keep theirs. */
export function deleteSecret(
  db: Database,
  scope: string,
  scopeId: string,
  name: string,
): boolean {
  if (!isSecretScope(scope)) return false;
  return (
    db
      .query(
        "DELETE FROM secret WHERE name = ?1 AND scope = ?2 AND scope_id = ?3",
      )
      .run(name, scope, ownerOf(scope, scopeId)).changes > 0
  );
}

export interface SecretReader {
  /** Organization and repository ids the secret is wanted for. */
  readonly org?: string | undefined;
  readonly repo?: string | undefined;
  /** Who is asking and for which run, as the audit will say. */
  readonly actor?: string | undefined;
  readonly run?: string | undefined;
  /** Open without a `secret.read` event or a `last_read_at` stamp; the caller audits what it chooses to. */
  readonly quiet?: boolean | undefined;
}

/**
 * The ONLY read path. For each requested name the narrowest scope that has
 * it wins — repository, then organization, then the forge — and is opened
 * and returned; a name nobody set is simply absent. Each open appends a
 * `secret.read` event naming actor, run, name and scope, never the value,
 * and stamps `last_read_at`. A row that will not open (key rotated, row
 * tampered with) is skipped and logged by name, and leaves no read event.
 */
export function resolveSecrets(
  db: Database,
  dataDir: string,
  bus: EventBus,
  names: readonly string[],
  who: SecretReader = {},
): Record<string, string> {
  const scoped = resolveScoped(db, dataDir, bus, names, who);
  return Object.fromEntries(
    Object.entries(scoped).map(([name, s]) => [name, s.value]),
  );
}

/** `resolveSecrets`, with the scope each value was found at. */
export function resolveScoped(
  db: Database,
  dataDir: string,
  bus: EventBus,
  names: readonly string[],
  who: SecretReader = {},
): Record<string, { value: string; scope: SecretScope }> {
  const out: Record<string, { value: string; scope: SecretScope }> = {};
  const ladder: [SecretScope, string][] = [];
  if (who.repo) ladder.push(["repo", who.repo]);
  if (who.org) ladder.push(["org", who.org]);
  ladder.push(["forge", ""]);

  for (const name of names) {
    if (!isSecretName(name) || name in out) continue;
    for (const [scope, scopeId] of ladder) {
      const row = db
        .query<{ value_enc: string }, [string, string, string]>(
          "SELECT value_enc FROM secret WHERE name = ?1 AND scope = ?2 AND scope_id = ?3",
        )
        .get(name, scope, scopeId);
      if (!row) continue;
      const opened = open(dataDir, row.value_enc, aad(scope, name));
      if (!opened.ok) {
        log.warn("secret will not open; skipped", {
          name,
          scope,
          reason: opened.error,
        });
        break;
      }
      if (who.quiet === true) {
        out[name] = { value: opened.value, scope };
        break;
      }
      db.query(
        `UPDATE secret SET last_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE name = ?1 AND scope = ?2 AND scope_id = ?3`,
      ).run(name, scope, scopeId);
      bus.append({
        kind: "secret.read",
        repoId: who.repo,
        actorId: who.actor,
        payload: { name, scope, run: who.run ?? null },
      });
      out[name] = { value: opened.value, scope };
      break;
    }
  }
  return out;
}
