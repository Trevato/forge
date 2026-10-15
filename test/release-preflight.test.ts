/**
 * `bun src/main.ts --preflight` (#1674): a tree that can boot says so in one
 * line and exits 0; one whose migration breaks names the migration and exits
 * 1; either way the live database is not touched and no copy is left behind.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { preflight } from "../src/kernel/preflight.ts";

const tree = join(import.meta.dir, "..", "src");
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "preflight-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function liveDb(name: string, upTo: readonly string[]): string {
  const data = join(dir, name);
  mkdirSync(data);
  openDb(join(data, "forge.db"), upTo).close();
  return data;
}

function run(data: string) {
  const p = Bun.spawnSync(["bun", join(tree, "main.ts"), "--preflight"], {
    env: { ...process.env, FORGE_DATA: data, FORGE_APP_URL: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString() + p.stderr.toString(),
  };
}

describe("--preflight", () => {
  test("a good tree passes with one line, over a database one migration behind", () => {
    const data = liveDb("behind", migrations.slice(0, -1));
    const { code, out } = run(data);
    expect(code).toBe(0);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("preflight ok");
  });

  test("a good tree passes with no database at all", () => {
    const { code } = run(join(dir, "fresh"));
    expect(code).toBe(0);
  });

  test("a broken migration fails and is named", () => {
    const data = liveDb("broken", migrations);
    const bad = [...migrations, "CREATE TABLE ok_one (id INTEGER);", "ALTER TABLE nowhere ADD COLUMN x TEXT;"];
    const result = preflight({ FORGE_DATA: data }, tree, bad);
    expect(result.ok).toBe(false);
    expect(result.line).toContain(`migration ${bad.length} failed`);
    expect(result.line.split("\n")).toHaveLength(1);
  });

  test("the live database is byte-identical afterwards and no copy remains", () => {
    const data = liveDb("bytes", migrations.slice(0, -1));
    const before = readFileSync(join(data, "forge.db"));
    const files = readdirSync(data).sort();
    expect(run(data).code).toBe(0);
    const bad = [...migrations, "SELECT * FROM nowhere;"];
    expect(preflight({ FORGE_DATA: data }, tree, bad).ok).toBe(false);
    expect(Buffer.compare(readFileSync(join(data, "forge.db")), before)).toBe(0);
    expect(readdirSync(data).sort()).toEqual(files);
  });

  test("a configuration that will not parse fails before any database work", () => {
    const result = preflight(
      { FORGE_DATA: join(dir, "cfg"), FORGE_TRUSTED_PROXIES: "not-an-address" },
      tree,
      migrations,
    );
    expect(result.ok).toBe(false);
    expect(result.line).toContain("FORGE_TRUSTED_PROXIES");
    expect(readdirSync(dir)).not.toContain("cfg");
  });

  test("a FORGE_URL or FORGE_APP_URL that is not a URL fails naming the variable", () => {
    const data = join(dir, "url");
    const url = preflight({ FORGE_DATA: data, FORGE_URL: "not a url" }, tree, migrations);
    expect(url.ok).toBe(false);
    expect(url.line).toContain("FORGE_URL");
    const hosted = preflight(
      { FORGE_DATA: data, FORGE_APP_URL: "not a url" },
      tree,
      migrations,
    );
    expect(hosted.ok).toBe(false);
    expect(hosted.line).toContain("FORGE_APP_URL");
  });

  test("a data directory that is the tree itself is refused", () => {
    // The gate may run from a tree with no .git, so make the checkout here.
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    const init = Bun.spawnSync(["git", "init", "-q", repo]);
    expect(init.exitCode).toBe(0);
    const result = preflight({ FORGE_DATA: repo }, join(repo, "src"), migrations);
    expect(result.ok).toBe(false);
    expect(result.line).toStartWith("preflight failed:");
    expect(readdirSync(repo).sort()).toEqual([".git", "src"]);
  });

  test("the write-ahead log is copied: an unmigrated commit in it is seen", () => {
    const data = join(dir, "wal");
    mkdirSync(data);
    const live = new Database(join(data, "forge.db"), { create: true, strict: true });
    live.run("PRAGMA journal_mode = WAL");
    live.run("PRAGMA wal_autocheckpoint = 0");
    live.run("CREATE TABLE only_in_wal (x)");
    expect(readdirSync(data)).toContain("forge.db-wal");
    const needsIt = ["INSERT INTO only_in_wal VALUES (1)"];
    const result = preflight({ FORGE_DATA: data }, tree, needsIt);
    live.close();
    // Without the -wal copy the table is absent and this migration fails.
    expect(result.line).toStartWith("preflight ok");
  });

  test("a scratch directory left by a killed run is swept; a fresh one is not", () => {
    const data = liveDb("stale", migrations);
    const old = join(data, "preflight-old");
    const fresh = join(data, "preflight-fresh");
    mkdirSync(old);
    mkdirSync(fresh);
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(old, longAgo, longAgo);
    expect(preflight({ FORGE_DATA: data }, tree, migrations).ok).toBe(true);
    expect(readdirSync(data).sort()).toEqual(["forge.db", "preflight-fresh"]);
  });

  test("boot with a bad FORGE_URL exits 1 with that one line", () => {
    const p = Bun.spawnSync(["bun", join(tree, "main.ts")], {
      env: {
        ...process.env,
        FORGE_DATA: join(dir, "boot"),
        FORGE_APP_URL: "",
        FORGE_URL: "not a url",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(p.exitCode).toBe(1);
    const lines = p.stderr.toString().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("FORGE_URL");
  });
});
