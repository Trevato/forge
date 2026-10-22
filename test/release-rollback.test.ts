/**
 * `--rollback <sha>` (#1823): a kept release is swapped to through the same
 * health-read swap as a landing; an unknown sha and one whose schema is
 * behind the live database's are refused in one line.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDir } from "../src/release/checkout.ts";
import type { App } from "../src/app.ts";
import { canRollBackTo } from "../src/release/gate.ts";
import type { Release } from "../src/release/record.ts";
import { liveSchema, rollback, schemaCount } from "../src/release/rollback.ts";

const KEPT = "a".repeat(40);
const OLDER = "b".repeat(40);
const GONE = "c".repeat(40);

const STAND_IN = `
Bun.serve({
  port: Number(process.env.PORT),
  reusePort: true,
  fetch: () => Response.json({ ok: true, draining: false, commit: process.env.FORGE_COMMIT }),
});
`;

const dirs: string[] = [];
const pids: number[] = [];
afterAll(async () => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function emptyDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "forge-rollback-"));
  dirs.push(dir);
  return dir;
}

async function dataDir(live: number): Promise<string> {
  const dir = await emptyDir();
  const db = new Database(join(dir, "forge.db"), { create: true });
  db.exec("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, position INTEGER, applied_at TEXT)");
  for (let i = 0; i < live; i++) db.exec(`INSERT INTO schema_migration VALUES ('m${i}', ${i + 1}, 'now')`);
  db.close();
  return dir;
}

function keep(data: string, sha: string, migrations: number): void {
  const dir = releaseDir(data, sha);
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  writeFileSync(join(dir, "src", "main.ts"), STAND_IN);
  writeFileSync(
    join(dir, "src", "core", "schema.ts"),
    `export const migrations = ${JSON.stringify(Array.from({ length: migrations }, (_, i) => `SELECT ${i}`))};\n`,
  );
}

async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = s.port ?? 0;
  s.stop(true);
  return port;
}

describe("rollback", () => {
  test("a kept sha swaps and health names it", async () => {
    const data = await dataDir(3);
    keep(data, KEPT, 3);
    const port = await freePort();
    const res = await rollback({ dataDir: data, sha: KEPT, port, env: process.env, budgetMs: 15_000 });
    expect(res.ok).toBe(true);
    if (res.ok) pids.push(res.pid);
    const body = (await (await fetch(`http://127.0.0.1:${port}/api/v1/health`)).json()) as { commit: string };
    expect(body.commit).toBe(KEPT);
  });

  test("an unknown or pruned sha is refused naming it", async () => {
    const data = await dataDir(3);
    const res = await rollback({ dataDir: data, sha: GONE, port: await freePort(), env: process.env });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.line).toContain(GONE);
      expect(res.line).not.toContain("\n");
    }
  });

  test("a sha that is not hex cannot reach the filesystem", async () => {
    const data = await dataDir(1);
    const res = await rollback({ dataDir: data, sha: "../../etc", port: await freePort(), env: process.env });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.line).not.toContain("etc");
  });

  test("a release with an older schema than the live database is refused", async () => {
    const data = await dataDir(5);
    keep(data, OLDER, 3);
    const res = await rollback({ dataDir: data, sha: OLDER, port: await freePort(), env: process.env });
    expect(res).toEqual({
      ok: false,
      line: `${OLDER} predates schema 5; rolling back would need a down-migration`,
    });
  });

  test("a release with a newer schema than the live database is allowed", async () => {
    const data = await dataDir(3);
    keep(data, KEPT, 5);
    const port = await freePort();
    const res = await rollback({ dataDir: data, sha: KEPT, port, env: process.env, budgetMs: 15_000 });
    expect(res.ok).toBe(true);
    if (res.ok) pids.push(res.pid);
  });

  test("a release with no readable schema is refused", async () => {
    const data = await dataDir(1);
    const none = releaseDir(data, KEPT);
    mkdirSync(join(none, "src"), { recursive: true });
    writeFileSync(join(none, "src", "main.ts"), STAND_IN);
    const missing = await rollback({ dataDir: data, sha: KEPT, port: await freePort(), env: process.env });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.line).toContain("has no readable schema");

    keep(data, OLDER, 1);
    writeFileSync(join(releaseDir(data, OLDER), "src", "core", "schema.ts"), "throw new Error('broken');\n");
    const broken = await rollback({ dataDir: data, sha: OLDER, port: await freePort(), env: process.env });
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.line).toContain("has no readable schema");
  });
});

describe("liveSchema", () => {
  test("no database is schema 0", async () => {
    expect(liveSchema(await emptyDir())).toBe(0);
  });

  test("a legacy database counts its user_version", async () => {
    const data = await emptyDir();
    const db = new Database(join(data, "forge.db"), { create: true });
    db.exec("PRAGMA user_version = 4");
    db.close();
    expect(liveSchema(data)).toBe(4);
    keep(data, OLDER, 2);
    const res = await rollback({ dataDir: data, sha: OLDER, port: await freePort(), env: process.env });
    expect(res).toEqual({
      ok: false,
      line: `${OLDER} predates schema 4; rolling back would need a down-migration`,
    });
  });
});

describe("schemaCount", () => {
  test("counts schema_migration rows, and falls back to user_version without the table", () => {
    const db = new Database(":memory:");
    db.exec("PRAGMA user_version = 4");
    expect(schemaCount(db)).toBe(4);
    db.exec("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, position INTEGER, applied_at TEXT)");
    expect(schemaCount(db)).toBe(0);
    db.exec("INSERT INTO schema_migration VALUES ('a', 1, 'now'), ('b', 2, 'now')");
    expect(schemaCount(db)).toBe(2);
    db.close();
  });
});

describe("canRollBackTo", () => {
  // The open connection is the live database; dataDir/forge.db is left absent, so the old
  // on-disk read (schema 0) would allow every kept release.
  test("compares a kept release with the open app.db, not the file in the data dir", async () => {
    const data = await emptyDir();
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migration (id TEXT PRIMARY KEY, position INTEGER, applied_at TEXT)");
    for (let i = 0; i < 3; i++) db.exec(`INSERT INTO schema_migration VALUES ('m${i}', ${i + 1}, 'now')`);
    const app = { db, config: { dataDir: data } } as unknown as App;
    const rel = (sha: string): Release => ({ sha, ok: true }) as unknown as Release;
    keep(data, OLDER, 2);
    keep(data, KEPT, 3);
    expect(await canRollBackTo(app, rel(OLDER))).toBe(false);
    expect(await canRollBackTo(app, rel(KEPT))).toBe(true);
    db.close();
  });
});

describe("--rollback command line", () => {
  const run = async (args: string[], env: Record<string, string>) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args], {
      env: { ...process.env, FORGE_SSH_PORT: "0", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    return { err: err.trim(), code };
  };

  test("a missing sha exits 1 with one line", async () => {
    const data = await emptyDir();
    const { err, code } = await run(["--rollback"], { FORGE_DATA: data });
    expect(code).toBe(1);
    expect(err.split("\n")).toHaveLength(1);
  });

  test("a bad PORT exits 1 with one line", async () => {
    const data = await emptyDir();
    const { err, code } = await run(["--rollback", KEPT], { FORGE_DATA: data, PORT: "abc" });
    expect(code).toBe(1);
    expect(err.split("\n")).toHaveLength(1);
    expect(err).toContain("PORT");
  });
});
