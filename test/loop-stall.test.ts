/**
 * The next stall names itself (#6957): the always-on gauge warns when the
 * loop wakes over a second late, a statement that holds the thread past
 * 200 ms is logged with the stack that called it, and a forge booting
 * beside another one's live runs holds its own work until they are gone.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { watchStalls } from "../src/kernel/loop_lag.ts";
import { sqlHead, timeStatements } from "../src/kernel/slow_sql.ts";
import { holdLease } from "../src/runs/lease.ts";
import { PEER_FRESH_MS, peerRuns, waitForPeer } from "../src/runs/peer.ts";
import type { LogFields } from "../src/kernel/log.ts";

type Line = { message: string; fields?: LogFields };
const recorder = () => {
  const lines: Line[] = [];
  const push = (message: string, fields?: LogFields) => void lines.push({ message, ...(fields ? { fields } : {}) });
  return { lines, log: { debug: push, info: push, warn: push, error: push } };
};

describe("the stall gauge", () => {
  test("a wake later than the floor is one warning saying how late; an on-time loop says nothing", async () => {
    const { lines, log } = recorder();
    const stop = watchStalls(log, 150, 10);
    try {
      await Bun.sleep(100);
      expect(lines).toEqual([]);
      const until = performance.now() + 300;
      while (performance.now() < until) {
        /* hold the thread */
      }
      await Bun.sleep(50);
    } finally {
      stop();
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe("event loop stalled");
    expect(Number(lines[0]!.fields?.lateMs)).toBeGreaterThanOrEqual(150);
  });
});

describe("slow statements", () => {
  test("a statement over the floor is logged with its SQL and the caller's stack; a fast one is not", () => {
    const db = new Database(":memory:");
    const { lines, log } = recorder();
    // A clock that says every call took 250 ms, until it is told otherwise.
    let step = 250;
    let t = 0;
    timeStatements(db, log, 200, () => (t += step));
    db.run("CREATE TABLE t (x INTEGER)");
    db.query("INSERT INTO t VALUES (?1)").run(1);
    db.prepare("SELECT   x\n FROM t").all();
    db.transaction(() => db.query("SELECT 1").get()).immediate();
    step = 0;
    db.query("SELECT x FROM t").all();
    db.exec("SELECT 1");
    const sqls = lines.map((l) => l.fields?.sql);
    expect(lines.every((l) => l.message === "slow statement held the thread")).toBe(true);
    expect(sqls).toContain("CREATE TABLE t (x INTEGER)");
    expect(sqls).toContain("INSERT INTO t VALUES (?1)");
    expect(sqls).toContain("SELECT x FROM t");
    expect(sqls).toContain("BEGIN IMMEDIATE");
    expect(lines.every((l) => String(l.fields?.stack).includes("loop-stall.test.ts"))).toBe(true);
    expect(lines.some((l) => String(l.fields?.stack).includes("slow_sql.ts"))).toBe(false);
    expect(lines).toHaveLength(6);
    db.close();
  });

  test("every statement is counted under its caller, and the top ten are one line a minute", () => {
    const db = new Database(":memory:");
    const { lines, log } = recorder();
    let wall = 60_000 * 100;
    timeStatements(db, log, 200, () => 0, () => wall);
    db.run("CREATE TABLE t (x INTEGER)");
    const insert = (x: number) => db.query("INSERT INTO t VALUES (?1)").run(x);
    for (let i = 0; i < 5; i++) insert(i);
    expect(lines).toHaveLength(0);
    wall += 60_000;
    db.query("SELECT x FROM t").all();
    const told = lines.filter((l) => l.message === "statements by caller, last minute");
    expect(told).toHaveLength(1);
    const top = JSON.parse(String(told[0]!.fields?.top)) as { caller: string; n: number; sql: string }[];
    expect(top.length).toBeLessThanOrEqual(10);
    const inserts = top.find((r) => r.sql.startsWith("INSERT"));
    expect(inserts?.n).toBe(5);
    expect(inserts?.caller).toContain("loop-stall.test.ts");
    db.close();
  });

  test("a lock held by another process is the slow statement, named", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-slowsql-"));
    const file = join(dir, "db.sqlite");
    const db = new Database(file, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 5000");
    db.run("CREATE TABLE t (x INTEGER)");
    const holder = Bun.spawn(
      ["bun", "-e", `const { Database } = require("bun:sqlite"); const d = new Database(${JSON.stringify(file)}); d.run("BEGIN IMMEDIATE"); console.log("held"); setTimeout(() => { d.run("COMMIT"); process.exit(0); }, 400);`],
      { stdout: "pipe" },
    );
    try {
      const reader = holder.stdout.getReader();
      await reader.read();
      const { lines, log } = recorder();
      timeStatements(db, log);
      db.query("INSERT INTO t VALUES (1)").run();
      expect(lines).toHaveLength(1);
      expect(lines[0]!.fields?.sql).toBe("INSERT INTO t VALUES (1)");
      expect(Number(lines[0]!.fields?.ms)).toBeGreaterThanOrEqual(200);
    } finally {
      await holder.exited;
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the SQL is one line, at most 100 characters", () => {
    expect(sqlHead("SELECT a,\n   b FROM c")).toBe("SELECT a, b FROM c");
    expect(sqlHead(`SELECT ${"x".repeat(200)}`)).toHaveLength(100);
  });
});

describe("another forge's live runs", () => {
  const withApp = async (body: (db: Database) => Promise<void> | void) => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-peer-"));
    const app = createApp({ dataDir, port: 0 });
    app.db.run("PRAGMA foreign_keys = OFF");
    try {
      await body(app.db);
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  const run = (db: Database, id: string, state: string, heartbeatAt: string | null) =>
    db.query("INSERT INTO run (id, repo_id, kind, state, heartbeat_at) VALUES (?1, 'r', 'check', ?2, ?3)").run(id, state, heartbeatAt);

  test("a running run renewed lately counts; a lapsed one, a finished one and one this process holds do not", () =>
    withApp((db) => {
      const now = Date.parse("2026-10-27T11:37:30.000Z");
      const at = (ago: number) => new Date(now - ago).toISOString();
      run(db, "fresh", "running", at(1_000));
      run(db, "edge", "running", at(PEER_FRESH_MS - 1));
      run(db, "lapsed", "running", at(PEER_FRESH_MS + 1));
      run(db, "never", "running", null);
      run(db, "done", "ok", at(1_000));
      run(db, "mine", "running", at(1_000));
      expect(peerRuns(db, now)).toBe(3);
      const release = holdLease(db, "mine");
      // Holding renews it now, which is after `now`: still fresh, and still not a peer's.
      expect(peerRuns(db, now)).toBe(2);
      release();
    }));

  test("nobody there: no wait, no line", () =>
    withApp(async (db) => {
      const { lines, log } = recorder();
      expect(await waitForPeer(db, log, { sleep: async () => {} })).toBe("alone");
      expect(lines).toEqual([]);
    }));

  test("the wait says so once, polls until the peer's runs finish, and says it let go", () =>
    withApp(async (db) => {
      run(db, "a", "running", new Date().toISOString());
      run(db, "b", "running", new Date().toISOString());
      const { lines, log } = recorder();
      let polls = 0;
      const outcome = await waitForPeer(db, log, {
        sleep: async () => {
          polls++;
          if (polls === 1) db.run("UPDATE run SET state = 'ok' WHERE id = 'a'");
          if (polls === 2) db.run("UPDATE run SET state = 'ok' WHERE id = 'b'");
        },
      });
      expect(outcome).toBe("gone");
      expect(polls).toBe(2);
      expect(lines.map((l) => l.message)).toEqual([
        "another forge still works this database: this one serves, and starts its own work once it lets go",
        "the other forge let go of this database; starting work",
      ]);
      expect(lines[0]!.fields?.runs).toBe(2);
    }));

  test("a peer that never lets go is waited out at the ceiling", () =>
    withApp(async (db) => {
      const { lines, log } = recorder();
      let clock = Date.now();
      run(db, "a", "running", new Date(clock).toISOString());
      const outcome = await waitForPeer(db, log, {
        maxMs: 10_000,
        now: () => clock,
        sleep: async (ms) => {
          clock += ms;
          db.run("UPDATE run SET heartbeat_at = ?1 WHERE id = 'a'", [new Date(clock).toISOString()]);
        },
      });
      expect(outcome).toBe("waited out");
      expect(lines.at(-1)?.message).toBe("another forge still works this database; starting beside it");
    }));
});
