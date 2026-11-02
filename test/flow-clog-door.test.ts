/**
 * The clog on a door (#6757): the tick's other reasons print no "Time to
 * detect", a corrupt row and a restart are survived, and the standing clog and
 * the last cleared note show to the admin on home and in the Flow dialog, never to a guest or an agent.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { lastClearedNote, startClogTick, tickClog } from "../src/flow/clog_tick.ts";
import { clogLines, readClog } from "../src/flow/clog_read.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const T0 = new Date("2026-10-26T12:00:00.000Z");
const ago = (): string => new Date(T0.getTime() - 5 * 3_600_000).toISOString();
const after = (min: number): Date => new Date(T0.getTime() + min * 60_000);

let root: string;
let app: App;
let servers: Servers;
let uid: string;
let n = 0;
let was: string | undefined;
let adminCookie = "";
let guestCookie = "";

async function signIn(username: string): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

beforeAll(async () => {
  was = process.env.FORGE_SENTINEL_REPO;
  process.env.FORGE_SENTINEL_REPO = "alice/forge";
  root = mkdtempSync(join(tmpdir(), "clog-door-"));
  app = createApp({ dataDir: root, port: 0 });
  for (const [username, first] of [["alice", true], ["guest", false]] as const) {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    if (first) uid = u.value.id;
  }
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'forge', 'public')", [uid]);
  servers = await serve(app);
  adminCookie = await signIn("alice");
  guestCookie = await signIn("guest");
});
afterAll(() => {
  if (was === undefined) delete process.env.FORGE_SENTINEL_REPO;
  else process.env.FORGE_SENTINEL_REPO = was;
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const reset = (): void => {
  app.db.run("DELETE FROM clog_state");
  app.db.run("DELETE FROM event");
  app.db.run("DELETE FROM issue");
};

function pull(createdAt: string, merged: string | null = null): string {
  const id = `p${++n}`;
  app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, author_id, state, created_at) VALUES (?1, 'pub', ?2, 'pull', 't', ?3, 'open', ?4)", [id, n, uid, createdAt]);
  app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, '', 'h', ?3)", [id, `b${n}`, merged]);
  return id;
}

const cleared = (at: Date): string => lastClearedNote(app.db, at) ?? "";

test("a landing-ratio clog starts at the reading and its note prints no Time to detect", () => {
  reset();
  for (let i = 0; i < 10; i++) pull(T0.toISOString());
  expect(tickClog(app.db, app.bus, T0).event).toBe("started");
  const row = app.db.query<{ since: number; started_at: number }, []>("SELECT since, started_at FROM clog_state").get()!;
  expect(row.started_at).toBe(row.since);
  app.db.run("DELETE FROM issue");
  tickClog(app.db, app.bus, after(1));
  expect(tickClog(app.db, app.bus, after(2)).event).toBe("cleared");
  expect(cleared(after(2))).toContain("Cause: 0 landed of 10 opened");
  expect(cleared(after(2))).not.toContain("Time to detect");
});

test("a conflict clog starts at the reading too", () => {
  reset();
  for (let i = 0; i < 11; i++) {
    const id = pull(ago());
    app.db.run("INSERT INTO run (id, repo_id, kind, state, issue_id, reason, created_at) VALUES (?1, 'pub', 'agent', 'queued', ?2, 'conflict', ?3)", [`r${id}`, id, T0.toISOString()]);
  }
  expect(tickClog(app.db, app.bus, T0).event).toBe("started");
  const row = app.db.query<{ since: number; started_at: number }, []>("SELECT since, started_at FROM clog_state").get()!;
  expect(row.started_at).toBe(row.since);
  app.db.run("DELETE FROM run");
});

test("a corrupt reasons row is a clog with no recorded cause, and a standing row resumes after a restart", () => {
  reset();
  app.db.run("INSERT INTO clog_state (id, since, started_at, first_reasons, quiet) VALUES (1, ?1, ?2, '{not json', 1)", [T0.getTime(), T0.getTime() - 3_600_000]);
  const read = readClog(app.db);
  expect(read.standing?.reasons).toEqual([]);
  expect(clogLines(read, T0.getTime())[0]).toContain("cause not recorded");
  // The next quiet reading (a fresh tick, as after a restart) finishes the clear from the stored row.
  expect(tickClog(app.db, app.bus, after(1)).event).toBe("cleared");
  expect(cleared(after(1))).toContain("Cause: not recorded");
  expect(cleared(after(1))).toContain("Time to detect: 60 min");
});

test("clogLines: the standing clog, then the last cleared note", () => {
  const read = { standing: { since: T0.getTime(), startedAt: T0.getTime() - 30 * 3_600_000, reasons: ["a", "b"] }, last: "Clog cleared. Cause: x. · Time to detect: 5 min · Time to clear: 2 min" };
  const lines = clogLines(read, T0.getTime());
  expect(lines[0]).toBe("Clogged for 30 h (noticed 30 h in): a; b.");
  expect(lines[1]).toBe("Clog cleared. Cause: x. · Time to detect: 5 min · Time to clear: 2 min");
  expect(clogLines({ standing: null, last: null }, T0.getTime())).toEqual([]);
});

test("the clog is in the Flow dialog for the admin, never on home (#8015), never to a guest or an agent", async () => {
  reset();
  app.db.run("INSERT INTO clog_state (id, since, started_at, first_reasons, quiet) VALUES (1, ?1, ?1, ?2, 0)", [Date.now(), JSON.stringify(["31 pulls conflict <b>"])]);
  const home = async (cookie: string): Promise<string> => (await fetch(`${servers.url}/`, { headers: { cookie } })).text();
  expect(await home(adminCookie)).not.toContain("pulls conflict");
  expect(await home(guestCookie)).not.toContain("pulls conflict");
  expect(flowLines(app.db, new Date(), [], undefined, []).join("\n")).toContain("31 pulls conflict");
  expect(flowLines(app.db, new Date(), [], { queues: [] }, []).join("\n")).not.toContain("31 pulls conflict");
});

test("startClogTick runs the tick on its interval, reports a throw, and stops", async () => {
  reset();
  for (let i = 0; i < 10; i++) pull(new Date().toISOString());
  const errors: unknown[] = [];
  const stop = startClogTick(app.db, app.bus, (e) => errors.push(e), 5);
  await Bun.sleep(40);
  stop();
  expect(app.db.query("SELECT 1 FROM clog_state").get()).not.toBeNull();
  expect(errors).toEqual([]);
  app.db.run("DROP TABLE clog_state");
  const broken = startClogTick(app.db, app.bus, (e) => errors.push(e), 5);
  await Bun.sleep(40);
  broken();
  expect(errors.length).toBeGreaterThan(0);
});
