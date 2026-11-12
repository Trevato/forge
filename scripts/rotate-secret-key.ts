/**
 * `bun scripts/rotate-secret-key.ts [--apply]`: finish a key rotation in one
 * deliberate step (#11473). Reads `$FORGE_DATA` (stop the forge first).
 *
 * With no `secret.key.old` beside the key, a run mints a fresh key, re-seals
 * every sealed column under it in one transaction, then keeps the old key as
 * `secret.key.old` and puts the new one in place as `secret.key`. With a
 * `secret.key.old` already there, a rotation is under way: the run mints
 * nothing and only moves what is still sealed under an older key onto the
 * current one. So a second run moves nothing, and the old key is never
 * overwritten while a value may still need it; delete `secret.key.old` once
 * you are satisfied, and the next run starts a new rotation.
 *
 * Dry run by default: it opens every value, counts, and writes nothing.
 * `--apply` writes. A value that opens under no key held is left as it is,
 * counted and warned about, and an apply that left one exits 3; the
 * transaction rolls back whole if any write fails.
 * Prints counts per table, never a plaintext and never a key.
 */

import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  forgetKey,
  keyId,
  type NamedKey,
  openWith,
  previousKeyPath,
  sealedKeyId,
  sealWith,
  secretKeyPath,
} from "../src/kernel/secret.ts";

/** Where a crashed apply left the key it was moving to. */
export const nextKeyPath = (dataDir: string): string => join(dataDir, "secret.key.next");

type Row = Record<string, string | number | null>;

/** One sealed column: its table, and the additional data each row's value is bound to. */
export interface SealedColumn {
  readonly table: string;
  readonly column: string;
  readonly aad: (row: Row) => string;
}

const s = (row: Row, key: string): string => String(row[key] ?? "");

/**
 * Every column the forge seals, with the AAD its writer binds it to — kept
 * beside the writers' own `aad` helpers: src/core/origins.ts,
 * src/origins/oauth.ts, src/core/prompts.ts, src/core/subscriptions.ts,
 * src/core/secret_store.ts, src/core/app_env.ts, src/core/oidc.ts and
 * src/apps/feature_env.ts. A new sealed column belongs here too.
 */
export const SEALED_COLUMNS: readonly SealedColumn[] = [
  { table: "origin", column: "token_enc", aad: (r) => s(r, "id") },
  { table: "origin", column: "refresh_token_enc", aad: (r) => s(r, "id") },
  { table: "origin_app", column: "client_secret_enc", aad: (r) => s(r, "id") },
  { table: "oauth_flow", column: "client_secret_enc", aad: (r) => s(r, "id") },
  { table: "oauth_flow", column: "verifier_enc", aad: (r) => s(r, "id") },
  { table: "oauth_flow", column: "device_code_enc", aad: (r) => s(r, "id") },
  { table: "oauth_flow", column: "target_enc", aad: (r) => s(r, "id") },
  { table: "prompt_source", column: "token_enc", aad: (r) => `prompt-source:${s(r, "id")}` },
  { table: "subscription", column: "token_enc", aad: (r) => `subscription:${s(r, "id")}` },
  { table: "secret", column: "value_enc", aad: (r) => `secret:${s(r, "scope")}:${s(r, "name")}` },
  { table: "app_env", column: "value_enc", aad: (r) => `${s(r, "app_id")}:${s(r, "name")}` },
  { table: "oidc_key", column: "private_jwk", aad: (r) => s(r, "kid") },
  {
    table: "app_feature_setting",
    column: "value",
    aad: (r) => `feature-setting:${s(r, "app_id")}:${s(r, "key")}`,
  },
];

/** What a run found for one table. */
export interface TableCount {
  readonly table: string;
  /** Re-sealed under the newest key (or would be, in a dry run). */
  moved: number;
  /** Already under the newest key. */
  kept: number;
  /** Sealed-looking, but opens under no key this directory holds: left as it is. */
  unopened: number;
}

export interface Rotation {
  readonly applied: boolean;
  /** True when this run mints the newest key; false when it finishes one under way. */
  readonly minted: boolean;
  /** The newest key's id (never the key). */
  readonly keyId: string;
  readonly tables: TableCount[];
}

function readKey(path: string): NamedKey | null {
  if (!existsSync(path)) return null;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) throw new Error(`${path} is mode ${mode.toString(8)}; it must be 0600`);
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error(`${path} is not a 32-byte key`);
  return { id: keyId(key), key };
}

function mintKey(): NamedKey {
  const key = randomBytes(32);
  return { id: keyId(key), key };
}

function writeKey(path: string, key: Buffer): void {
  writeFileSync(path, key, { mode: 0o600 });
  chmodSync(path, 0o600);
}

const looksSealed = (v: unknown): v is string =>
  typeof v === "string" && (v.startsWith("v1:") || v.startsWith("v2:"));

function hasTable(db: Database, table: string): boolean {
  return db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1").get(table) !== null;
}

/** Re-seal every sealed column under the newest key; writes only with `apply`. */
export function rotateSecretKey(dataDir: string, apply: boolean): Rotation {
  const dbPath = join(dataDir, "forge.db");
  if (!existsSync(dbPath)) throw new Error(`${dbPath} is missing: is FORGE_DATA the forge's data directory?`);
  // A crash between the two renames of an apply: the commit is done and the
  // old key already kept, so only the new key still has to take its place.
  if (apply && !existsSync(secretKeyPath(dataDir)) && existsSync(nextKeyPath(dataDir)) && existsSync(previousKeyPath(dataDir)))
    renameSync(nextKeyPath(dataDir), secretKeyPath(dataDir));
  const current = readKey(secretKeyPath(dataDir));
  if (current === null) throw new Error(`${secretKeyPath(dataDir)} is missing: there is nothing to rotate`);
  const previous = readKey(previousKeyPath(dataDir));
  // An apply that crashed after its commit, before the files moved, left
  // the key every value now names; it is the target, never a fresh one.
  const pending = readKey(nextKeyPath(dataDir));
  if (pending !== null && previous !== null)
    throw new Error("secret.key.old and secret.key.next are both here: keep the one the values name and move the other away by hand");
  const minted = previous === null;
  const target: NamedKey = pending ?? (minted ? mintKey() : current);
  const ring = [target, current, ...(previous ? [previous] : [])];

  const db = new Database(dbPath);
  const tables = new Map<string, TableCount>();
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    if (apply && minted && pending === null) writeKey(nextKeyPath(dataDir), target.key);
    const work = (): void => {
      for (const col of SEALED_COLUMNS) {
        if (!hasTable(db, col.table)) continue;
        const count = tables.get(col.table) ?? { table: col.table, moved: 0, kept: 0, unopened: 0 };
        tables.set(col.table, count);
        const rows = db.query<Row, []>(`SELECT rowid AS __rowid, * FROM "${col.table}"`).all();
        const update = db.query(`UPDATE "${col.table}" SET "${col.column}" = ?1 WHERE rowid = ?2`);
        for (const row of rows) {
          const value = row[col.column];
          if (!looksSealed(value)) continue;
          if (sealedKeyId(value) === target.id) {
            count.kept++;
            continue;
          }
          const aad = col.aad(row);
          const opened = openWith(ring, value, aad);
          if (!opened.ok) {
            count.unopened++;
            continue;
          }
          count.moved++;
          if (apply) update.run(sealWith(target, opened.value, aad), row.__rowid ?? null);
        }
      }
    };
    try {
      if (apply) db.transaction(work).immediate();
      else work();
    } catch (error) {
      // Rolled back whole: no value names the key that would have been new.
      if (apply && minted && pending === null) rmSync(nextKeyPath(dataDir), { force: true });
      throw error;
    }
  } finally {
    db.close();
  }

  if (apply && target.id !== current.id) {
    // Committed: keep the old key, then put the new one in place.
    renameSync(secretKeyPath(dataDir), previousKeyPath(dataDir));
    renameSync(nextKeyPath(dataDir), secretKeyPath(dataDir));
  } else if (apply && pending !== null) {
    rmSync(nextKeyPath(dataDir), { force: true });
  }
  if (apply) forgetKey(dataDir);
  return { applied: apply, minted: target.id !== current.id, keyId: target.id, tables: [...tables.values()] };
}

/** The report, one line per table: counts and key ids only. */
export function describeRotation(r: Rotation): string {
  const head = r.applied
    ? r.minted
      ? `rotated: every sealed value now opens under key ${r.keyId}; the old key is secret.key.old`
      : `finished: every sealed value now opens under key ${r.keyId}`
    : r.minted
      ? `dry run: would mint a new key and re-seal under it (run with --apply)`
      : `dry run: secret.key.old is kept, so this finishes a rotation onto key ${r.keyId} (run with --apply)`;
  const lines = r.tables.map(
    (t) => `  ${t.table.padEnd(20)} moved ${t.moved}, already current ${t.kept}${t.unopened ? `, unopenable ${t.unopened} (left as is)` : ""}`,
  );
  const moved = r.tables.reduce((n, t) => n + t.moved, 0);
  const lost = unopened(r);
  const warning = lost
    ? [`warning: ${lost} value(s) open under no key held and stay as they are: keep secret.key.old until they are resolved`]
    : [];
  return [head, ...lines, `${r.applied ? "moved" : "would move"} ${moved} in all`, ...warning].join("\n");
}

/** How many sealed values opened under no key held. */
export const unopened = (r: Rotation): number => r.tables.reduce((n, t) => n + t.unopened, 0);

/** The exit code: 3 when an apply left values it could not open, so nothing deletes secret.key.old after it. */
export const exitCode = (r: Rotation): number => (r.applied && unopened(r) > 0 ? 3 : 0);

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--apply");
  const dataDir = process.env.FORGE_DATA ?? "";
  if (unknown.length > 0 || dataDir === "") {
    console.error("usage: FORGE_DATA=<data dir> bun scripts/rotate-secret-key.ts [--apply]   (stop the forge first)");
    process.exit(2);
  }
  try {
    const rotation = rotateSecretKey(dataDir, args.includes("--apply"));
    console.log(describeRotation(rotation));
    process.exitCode = exitCode(rotation);
  } catch (error) {
    console.error(`rotate-secret-key: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
