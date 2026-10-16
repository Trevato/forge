/**
 * Can this tree boot? `bun src/main.ts --preflight` asks without starting
 * anything: the configuration parses, and every migration runs on a copy of
 * the database. One line out, exit 0 or 1. No socket is opened and the live
 * database is never opened — only read as bytes.
 *
 * The copy lives in a directory of its own under the data directory (the
 * same disk, so a database that fits fits twice) and is removed in a
 * `finally`, whatever happened.
 */

import { signupFromEnv } from "../settings/signup.ts";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { parseCidrs } from "./cidr.ts";
import { dataHomeRefusal } from "./data_home.ts";
import { applyPragmas } from "./db.ts";
import { migrate } from "./migrate.ts";

/** A scratch directory older than this was left by a killed run. */
const STALE_MS = 60 * 60 * 1000;

function sweepStale(dataDir: string): void {
  for (const name of readdirSync(dataDir)) {
    if (!name.startsWith("preflight-")) continue;
    const path = join(dataDir, name);
    try {
      if (Date.now() - statSync(path).mtimeMs > STALE_MS)
        rmSync(path, { recursive: true, force: true });
    } catch {
      // Gone already, or not ours to read: leave it.
    }
  }
}

export type Preflight = { ok: boolean; line: string };

/** Where this forge keeps its state: the same answer boot gives. */
export function dataDirOf(env: Record<string, string | undefined>): string {
  const hosted = (env.FORGE_APP_URL ?? "").trim() !== "";
  return env.FORGE_DATA ?? (hosted ? env.FORGE_APP_DATA : undefined) ?? "data";
}

/** Why the configuration will not boot, in one line; `null` when it will. */
export function configProblem(
  env: Record<string, string | undefined>,
  treeDir: string,
): string | null {
  const refusal = dataHomeRefusal(dataDirOf(env), treeDir);
  if (refusal !== null) return refusal;
  const proxies = (env.FORGE_TRUSTED_PROXIES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const parsed = parseCidrs(proxies.join(","));
  if (!parsed.ok)
    return `FORGE_TRUSTED_PROXIES: "${parsed.error}" is not an address or range`;
  const hosted = (env.FORGE_APP_URL ?? "").trim();
  const url = hosted !== "" ? hosted : (env.FORGE_URL ?? "").trim();
  if (url !== "") {
    try {
      new URL(url);
    } catch {
      return `${hosted !== "" ? "FORGE_APP_URL" : "FORGE_URL"}: "${url}" is not a URL`;
    }
  }
  const signup = signupFromEnv(env.FORGE_SIGNUP);
  if (!signup.ok) return signup.error;
  return null;
}

export function preflight(
  env: Record<string, string | undefined>,
  treeDir: string,
  migrations: readonly string[],
): Preflight {
  const bad = configProblem(env, treeDir);
  if (bad !== null) return { ok: false, line: `preflight failed: ${bad}` };

  const dataDir = dataDirOf(env);
  let scratch: string | undefined;
  try {
    mkdirSync(dataDir, { recursive: true });
    sweepStale(dataDir);
    scratch = mkdtempSync(join(dataDir, "preflight-"));
    const live = join(dataDir, "forge.db");
    const copy = join(scratch, "forge.db");
    // The write-ahead log holds commits the main file does not yet; the copy
    // needs both to be the database the forge would open.
    for (const suffix of ["", "-wal"])
      if (existsSync(live + suffix)) copyFileSync(live + suffix, copy + suffix);
    const db = new Database(copy, { create: true, strict: true });
    try {
      applyPragmas(db);
      migrate(db, migrations);
    } finally {
      db.close();
    }
    return {
      ok: true,
      line: `preflight ok: ${migrations.length} migrations apply to a copy of the database`,
    };
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error))
      .replace(/\s+/g, " ")
      .trim();
    return { ok: false, line: `preflight failed: ${message}` };
  } finally {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  }
}
