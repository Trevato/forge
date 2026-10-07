/**
 * During a roll two processes serve one forge (#875): the old one drains
 * while the new one answers. A suspension done in one must hold in both
 * (#846). The process that suspends writes the fact, and every process
 * enforces it, on each request and on its own sweep of what it holds open:
 * event streams, a git transfer under way, an SSH session.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { suspendAccount, unsuspendAccount } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { endAccountSession } from "../src/actions/signins.ts";
import { createApp, type App } from "../src/app.ts";
import { addKey, fingerprint, parseAuthorizedKey } from "../src/core/keys.ts";
import { createSession, listSessions } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { holdOpen, sweepStanding } from "../src/http/caller.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { forgeSshSession } from "../src/tui/ssh.ts";

const KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo sam";
const SWEEP_MS = 100;

describe("a suspension holds in every process serving the forge", () => {
  let dataDir: string;
  /** The process the owner acts through: the new one. */
  let fresh: App;
  /** The process still draining: it never sees the other's bus. */
  let draining: App;
  let freshServers: Servers;
  let drainingServers: Servers;
  let olive: User;
  let sam: User;

  const person = async (username: string, adminIfFirst = false) => {
    const made = await createUser(fresh.db, {
      trusted: true,
      username,
      email: `${username}@f.dev`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  /** Resolves true once `p` settles, false if it has not within `ms`. */
  const within = <T>(p: Promise<T>, ms = 3_000) =>
    Promise.race([p.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
  const streamOn = async (servers: Servers, cookie: string) => {
    const res = await fetch(`${servers.url}/events`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    await reader.read();
    return {
      ended: (async () => {
        for (;;) if ((await reader.read()).done) return;
      })(),
    };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-standing-"));
    fresh = createApp({ dataDir, port: 0, standingSweepMs: SWEEP_MS });
    draining = createApp({ dataDir, port: 0, standingSweepMs: SWEEP_MS });
    freshServers = await serve(fresh);
    drainingServers = await serve(draining);
    olive = await person("olive", true);
    sam = await person("sam");
    const made = await createRepo(fresh, sam, { name: "lab", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
  });
  afterAll(async () => {
    freshServers.stop();
    drainingServers.stop();
    fresh.close();
    draining.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an event stream on the draining process ends when the new one suspends", async () => {
    const cookie = `forge_session=${createSession(fresh.db, sam.id).token}`;
    const { ended } = await streamOn(drainingServers, cookie);
    expect((await suspendAccount(fresh, olive, "sam")).ok).toBe(true);
    expect(await within(ended)).toBe(true);
    // And the draining process refuses the account on the next request.
    const again = await fetch(`${drainingServers.url}/api/v1/user`, {
      headers: { cookie },
    });
    expect(again.status).toBe(401);
    expect(unsuspendAccount(fresh, olive, "sam").ok).toBe(true);
  });

  test("an SSH session on the draining process ends", async () => {
    const parsed = parseAuthorizedKey(KEY_LINE);
    if (!parsed.ok) throw new Error("key");
    expect(addKey(fresh.db, sam.id, "desk", parsed.value).ok).toBe(true);
    const closers: (() => void)[] = [];
    let exited: number | undefined;
    const session = {
      key: { fingerprint: fingerprint(parsed.value.blob), line: KEY_LINE },
      username: "sam",
      remoteAddress: "203.0.113.9",
      kind: "shell" as const,
      command: undefined,
      term: "xterm-256color",
      env: {},
      cols: 80,
      rows: 24,
      widthPx: 0,
      heightPx: 0,
      ended: false,
      pending: 0,
      write() {},
      writeStderr() {},
      onData() {},
      onResize() {},
      onEof() {},
      onClose(cb: () => void) {
        closers.push(cb);
      },
      exit(code: number) {
        if (exited !== undefined) return;
        exited = code;
        for (const cb of closers) cb();
      },
      drained: async () => {},
    };
    forgeSshSession(draining)(session as never);
    expect(exited).toBeUndefined();
    expect((await suspendAccount(fresh, olive, "sam")).ok).toBe(true);
    for (let i = 0; i < 30 && exited === undefined; i++) await Bun.sleep(SWEEP_MS);
    expect(exited).toBe(1);
    expect(unsuspendAccount(fresh, olive, "sam").ok).toBe(true);
  });

  test("a browser signed out through one process ends its streams on the other", async () => {
    const token = createSession(fresh.db, sam.id).token;
    const cookie = `forge_session=${token}`;
    const { ended } = await streamOn(drainingServers, cookie);
    const id = listSessions(fresh.db, sam.id, token).find((s) => s.current)!.id;
    expect(endAccountSession(fresh, sam, "sam", id).ok).toBe(true);
    expect(await within(ended)).toBe(true);
  });

  test("an account in good standing keeps its stream through the sweeps", async () => {
    const cookie = `forge_session=${createSession(fresh.db, sam.id).token}`;
    const { ended } = await streamOn(drainingServers, cookie);
    expect(await within(ended, SWEEP_MS * 6)).toBe(false);
  });
  // Last: a transfer cut mid-request leaves its connection to be dropped.
  test("a git transfer under way on the draining process is cut", async () => {
    const token = createToken(fresh.db, sam.id, "t", "rw").token;
    // An upload-pack whose negotiation never finishes: git waits on it,
    // so the transfer is under way for as long as nothing cuts it.
    const negotiation = new ReadableStream<Uint8Array>({
      start() {},
    });
    const transfer = fetch(`${drainingServers.url}/sam/lab.git/git-upload-pack`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`sam:${token}`).toString("base64")}`,
        "content-type": "application/x-git-upload-pack-request",
      },
      body: negotiation,
    }).then((r) => r.arrayBuffer());
    await Bun.sleep(300);
    expect(await within(transfer, 50)).toBe(false);
    expect((await suspendAccount(fresh, olive, "sam")).ok).toBe(true);
    expect(await within(transfer)).toBe(true);
    expect(unsuspendAccount(fresh, olive, "sam").ok).toBe(true);
  });
});

// The sweep runs on a bare timer in every process: nothing in it may throw.
describe("the standing sweep never takes the forge down", () => {
  test("a closer that throws is reported, and the others still close", () => {
    const db = new Database(":memory:");
    db.run(
      "CREATE TABLE user (id TEXT PRIMARY KEY, suspended_at TEXT, removed_at TEXT)",
    );
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, expires_at TEXT)");
    db.run("INSERT INTO user (id, suspended_at) VALUES ('u1', '2026-10-06')");
    let closed = 0;
    holdOpen(db, "u1", undefined, () => {
      throw new Error("socket already broken");
    });
    holdOpen(db, "u1", undefined, () => closed++);
    const errors: unknown[] = [];
    expect(() => sweepStanding(db, (e) => errors.push(e))).not.toThrow();
    expect(closed).toBe(1);
    expect(errors.length).toBe(1);
    db.close();
  });

  test("a closed database is reported, not thrown", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE user (id TEXT PRIMARY KEY, suspended_at TEXT, removed_at TEXT)");
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, expires_at TEXT)");
    const release = holdOpen(db, "u1", undefined, () => {});
    db.close();
    const errors: unknown[] = [];
    expect(() => sweepStanding(db, (e) => errors.push(e))).not.toThrow();
    expect(errors.length).toBe(1);
    release();
  });

  test("two forges in one process never sweep each other's holds", () => {
    const schema = (db: Database) => {
      db.run("CREATE TABLE user (id TEXT PRIMARY KEY, suspended_at TEXT, removed_at TEXT)");
      db.run("CREATE TABLE session (id TEXT PRIMARY KEY, expires_at TEXT)");
    };
    const mine = new Database(":memory:");
    const theirs = new Database(":memory:");
    schema(mine);
    schema(theirs);
    theirs.run("INSERT INTO user (id) VALUES ('t1')");
    let closed = false;
    const release = holdOpen(theirs, "t1", undefined, () => {
      closed = true;
    });
    // `t1` is nobody in this forge: its sweep must not touch the other's.
    sweepStanding(mine);
    expect(closed).toBe(false);
    release();
    mine.close();
    theirs.close();
  });

  test("many held accounts are asked a chunk at a time", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE user (id TEXT PRIMARY KEY, suspended_at TEXT, removed_at TEXT)");
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY, expires_at TEXT)");
    const insert = db.prepare("INSERT INTO user (id) VALUES (?1)");
    let closed = 0;
    for (let i = 0; i < 1200; i++) {
      // Every other one is in good standing; the rest are nobody.
      if (i % 2 === 0) insert.run(`u${i}`);
      holdOpen(db, `u${i}`, undefined, () => closed++);
    }
    const errors: unknown[] = [];
    sweepStanding(db, (e) => errors.push(e));
    expect(errors).toEqual([]);
    expect(closed).toBe(600);
    db.close();
  });
});
