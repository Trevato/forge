/**
 * `bun scripts/rotate-secret-key.ts` (#11473): every sealed column moves
 * from key A to a fresh key B in one transaction, and opens under B alone
 * once A is deleted. Dry run writes nothing; a second run moves nothing; a
 * failed write rolls back whole and keeps A in place.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import { setSecret } from "../src/core/secret_store.ts";
import { sealSetting } from "../src/apps/feature_env.ts";
import { signingKey } from "../src/core/oidc.ts";
import { openDb } from "../src/kernel/db.ts";
import { forgetKey, keyId, loadKey, open, previousKeyPath, seal, secretKeyPath } from "../src/kernel/secret.ts";
import { describeRotation, exitCode, nextKeyPath, rotateSecretKey, SEALED_COLUMNS } from "../scripts/rotate-secret-key.ts";

/** A row in `table` with every required column filled, `column` sealed under the current key. */
function plant(db: Database, dir: string, table: string, column: string, values: Record<string, string>, aad: string, plain: string): void {
  const cols = db.query<{ name: string; notnull: number; dflt_value: string | null }, []>(`PRAGMA table_info("${table}")`).all();
  const row: Record<string, string | number> = {};
  for (const c of cols) if (c.notnull && c.dflt_value === null) row[c.name] = 0;
  Object.assign(row, values, { [column]: seal(dir, plain, aad) });
  const names = Object.keys(row);
  db.query(`INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(
    ...(Object.values(row) as never[]),
  );
}

/** Each planted value: where it is, what it is bound to, what it says. */
const PLANTED = [
  { table: "origin", column: "token_enc", values: { id: "o1", kind: "github", login: "o1" }, aad: "o1", plain: "origin-token" },
  { table: "origin", column: "refresh_token_enc", values: { id: "o2", kind: "github", login: "o2" }, aad: "o2", plain: "refresh-token" },
  { table: "origin_app", column: "client_secret_enc", values: { id: "oa1", kind: "github", api_url: "https://oa1" }, aad: "oa1", plain: "app-secret" },
  { table: "oauth_flow", column: "client_secret_enc", values: { id: "f1", kind: "github", flow: "device", short_code: "f1" }, aad: "f1", plain: "flow-secret" },
  { table: "oauth_flow", column: "verifier_enc", values: { id: "f2", kind: "github", flow: "device", short_code: "f2" }, aad: "f2", plain: "flow-verifier" },
  { table: "oauth_flow", column: "device_code_enc", values: { id: "f3", kind: "github", flow: "device", short_code: "f3" }, aad: "f3", plain: "flow-device" },
  { table: "oauth_flow", column: "target_enc", values: { id: "f4", kind: "github", flow: "device", short_code: "f4" }, aad: "f4", plain: "flow-target" },
  { table: "prompt_source", column: "token_enc", values: { id: "p1" }, aad: "prompt-source:p1", plain: "prompt-token" },
  { table: "subscription", column: "token_enc", values: { id: "s1", kind: "oauth" }, aad: "subscription:s1", plain: "sub-token" },
  { table: "app_env", column: "value_enc", values: { app_id: "a1", name: "DB_URL", scope: "all" }, aad: "a1:DB_URL", plain: "env-value" },
  {
    table: "app_feature_setting",
    column: "value",
    values: { app_id: "a2", key: "API_KEY" },
    aad: "feature-setting:a2:API_KEY",
    plain: "feature-value",
  },
] as const;

/** Planted here, or written by the real writers in `beforeEach`. */
const WRITTEN = ["secret.value_enc", "oidc_key.private_jwk"];

const read = (db: Database, p: (typeof PLANTED)[number]): string => {
  const [k, v] = Object.entries(p.values)[0]!;
  return db.query<Record<string, string>, [string]>(`SELECT "${p.column}" AS v FROM "${p.table}" WHERE "${k}" = ?1`).get(v)!.v!;
};

describe("rotate-secret-key", () => {
  let dir = "";
  let db: Database;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "rotate-key-"));
    db = openDb(join(dir, "forge.db"), migrations);
    db.exec("PRAGMA foreign_keys = OFF");
    for (const p of PLANTED) plant(db, dir, p.table, p.column, p.values, p.aad, p.plain);
    // The feature-setting writer's own seal, so its AAD is the writer's and not a copy.
    db.query("UPDATE app_feature_setting SET value = ?1 WHERE app_id = 'a2'").run(sealSetting(dir, "a2", "API_KEY", "feature-value"));
    expect(setSecret(db, dir, "forge", "", "DEPLOY_TOKEN", "secret-value").ok).toBe(true);
    await signingKey(db, dir);
  });
  afterEach(() => {
    db.close();
    forgetKey(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  test("seals under A, rotates, and every value opens under B with A deleted", () => {
    const a = keyId(loadKey(dir));
    const dry = rotateSecretKey(dir, false);
    expect(dry.applied).toBe(false);
    expect(keyId(loadKey(dir))).toBe(a); // a dry run writes nothing
    expect(existsSync(previousKeyPath(dir))).toBe(false);
    const total = (r: typeof dry): number => r.tables.reduce((n, t) => n + t.moved, 0);
    expect(total(dry)).toBe(PLANTED.length + 2);

    const done = rotateSecretKey(dir, true);
    expect(total(done)).toBe(PLANTED.length + 2);
    expect(done.tables.find((t) => t.table === "secret")!.moved).toBe(1);
    expect(done.tables.find((t) => t.table === "oidc_key")!.moved).toBe(1);
    expect(keyId(readFileSync(previousKeyPath(dir)))).toBe(a);
    expect(done.keyId).not.toBe(a);
    expect(existsSync(nextKeyPath(dir))).toBe(false);

    // A deleted: only B remains, and everything opens.
    rmSync(previousKeyPath(dir));
    forgetKey(dir);
    expect(keyId(loadKey(dir))).toBe(done.keyId);
    for (const p of PLANTED) {
      const value = read(db, p);
      expect(value.split(":")[1]).toBe(done.keyId);
      expect(open(dir, value, p.aad)).toEqual({ ok: true, value: p.plain });
    }
    const secret = db.query<{ v: string }, []>("SELECT value_enc AS v FROM secret").get()!.v;
    expect(open(dir, secret, "secret:forge:DEPLOY_TOKEN")).toEqual({ ok: true, value: "secret-value" });
    const jwk = db.query<{ kid: string; v: string }, []>("SELECT kid, private_jwk AS v FROM oidc_key").get()!;
    expect(open(dir, jwk.v, jwk.kid).ok).toBe(true);

    // The report says counts and key ids, never a plaintext.
    const said = describeRotation(done);
    for (const p of PLANTED) expect(said).not.toContain(p.plain);
    expect(said).toContain(`moved ${PLANTED.length + 2} in all`);
    expect(said).not.toContain("warning");
    expect(exitCode(done)).toBe(0);
  });

  test("every sealed column is planted, and every *_enc column in the schema is in SEALED_COLUMNS", () => {
    const listed = SEALED_COLUMNS.map((c) => `${c.table}.${c.column}`).sort();
    expect([...new Set([...PLANTED.map((p) => `${p.table}.${p.column}`), ...WRITTEN])].sort()).toEqual(listed);
    const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    const inSchema = tables.flatMap(({ name }) =>
      db
        .query<{ name: string }, []>(`PRAGMA table_info("${name}")`)
        .all()
        .filter((c) => c.name.endsWith("_enc"))
        .map((c) => `${name}.${c.name}`),
    );
    // Sealed columns not named *_enc, checked by name so a rename shows here too.
    inSchema.push("oidc_key.private_jwk", "app_feature_setting.value");
    for (const col of inSchema) expect(listed).toContain(col);
  });

  test("an apply that leaves an unopenable value warns to keep secret.key.old and exits 3", async () => {
    plant(db, dir, "origin", "token_enc", { id: "lost", kind: "github", login: "lost" }, "not-its-id", "lost-token");
    const proc = Bun.spawn(["bun", join(import.meta.dir, "../scripts/rotate-secret-key.ts"), "--apply"], {
      env: { ...process.env, FORGE_DATA: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(3);
    expect(out).toContain("unopenable 1");
    expect(out).toContain("keep secret.key.old");
    expect(existsSync(previousKeyPath(dir))).toBe(true);
    // A dry run warns too, but only an apply fails.
    const dry = rotateSecretKey(dir, false);
    expect(describeRotation(dry)).toContain("keep secret.key.old");
    expect(exitCode(dry)).toBe(0);
  });

  test("a second run moves nothing and mints no key", () => {
    const first = rotateSecretKey(dir, true);
    const again = rotateSecretKey(dir, true);
    expect(again.minted).toBe(false);
    expect(again.keyId).toBe(first.keyId);
    expect(again.tables.reduce((n, t) => n + t.moved, 0)).toBe(0);
    expect(keyId(loadKey(dir))).toBe(first.keyId);
  });

  test("with secret.key.old kept, a run finishes the rotation onto the current key", () => {
    // The by-hand rotation: A kept as old, a fresh current minted on next use.
    const a = keyId(loadKey(dir));
    rotateSecretKey(dir, false);
    renameSync(secretKeyPath(dir), previousKeyPath(dir));
    forgetKey(dir);
    const b = keyId(loadKey(dir));
    const done = rotateSecretKey(dir, true);
    expect(done.minted).toBe(false);
    expect(done.keyId).toBe(b);
    expect(done.tables.reduce((n, t) => n + t.moved, 0)).toBe(PLANTED.length + 2);
    expect(keyId(readFileSync(previousKeyPath(dir)))).toBe(a); // never overwritten
  });

  test("a failed write rolls back whole and leaves key A in place", () => {
    const a = keyId(loadKey(dir));
    const before = PLANTED.map((p) => read(db, p));
    // oidc_key comes after origin, secret and app_env: their writes must not stay.
    db.exec(`CREATE TRIGGER no_write BEFORE UPDATE ON oidc_key BEGIN SELECT RAISE(ABORT, 'refused'); END`);
    expect(() => rotateSecretKey(dir, true)).toThrow();
    expect(PLANTED.map((p) => read(db, p))).toEqual(before);
    forgetKey(dir);
    expect(keyId(loadKey(dir))).toBe(a);
    expect(existsSync(previousKeyPath(dir))).toBe(false);
    expect(existsSync(nextKeyPath(dir))).toBe(false);
  });
});
