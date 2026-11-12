/**
 * Which repository is the forge's own source, as `owner/name`. Stored in
 * `forge_setting` under `forge_repo` by an admin (`PATCH /api/v1/admin/settings`
 * with `{"forgeRepo": "trevato/forge"}`, `null` to clear); with no row it is
 * `FORGE_REPO` from the environment, and with neither there is none.
 *
 * What it changes is only how that repository's app is shown
 * (`core/forge_repo.ts`): its production is the forge itself. Nothing routes
 * by it, and the forge's own hostname stays refused as an app domain.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { writeSetting } from "./limits.ts";

const STORE_KEY = "forge_repo";
const NAME =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `owner/name` from untrusted input, or `null` to clear; nothing else. */
export function parseForgeSource(
  raw: unknown,
): Result<string | null, "invalid_forge_repo"> {
  if (raw === null) return ok(null);
  return typeof raw === "string" && NAME.test(raw.trim())
    ? ok(raw.trim())
    : err("invalid_forge_repo");
}

/** The stored repository, or undefined when no admin named one. */
export function storedForgeSource(db: Database): string | undefined {
  const row = db
    .query<
      { value: string },
      [string]
    >("SELECT value FROM forge_setting WHERE key = ?1")
    .get(STORE_KEY);
  return row === null || !NAME.test(row.value) ? undefined : row.value;
}

/** The forge's own source: the stored one, else `FORGE_REPO`, else none. */
export function forgeSource(
  db: Database,
  fromEnv: string | undefined,
): string | undefined {
  return (
    storedForgeSource(db) ??
    (fromEnv !== undefined && NAME.test(fromEnv) ? fromEnv : undefined)
  );
}

/** Set (or with `null` clear) the stored repository and keep the change; the same value again keeps nothing. */
export function setForgeSource(
  db: Database,
  value: string | null,
  actorId: string,
): void {
  const from = storedForgeSource(db) ?? null;
  if (from === value) return;
  writeSetting(
    db,
    STORE_KEY,
    value,
    from ?? "unset",
    value ?? "unset",
    actorId,
  );
}
