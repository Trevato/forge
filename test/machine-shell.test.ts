/**
 * A writer's shell into a machine (#9471): the upgrade is refused to a
 * reader, a token and a page from elsewhere; a writer's keystrokes come back
 * on the pty; a resize frame reaches it; a second connection joins the same
 * session; and each session's start and end is a row in `machine_sessions`.
 *
 * This sandbox cannot hold a cell, so the bridge runs uncontained here on
 * purpose (`contain: "uncontained"`); a forge that cannot hold one refuses.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { existsSync } from "node:fs";
import { closeStaleSessions, recordStart, shellCell, workspace, MAX_SESSIONS } from "../src/machines/shell.ts";
import { BUILT_IN } from "../src/crew/machines.ts";
import {
  lastSessions,
  liveSessions,
  parseControl,
  setShellOptions,
  shellTarget,
  stopShells,
} from "../src/machines/shell.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let app: App;
let servers: Servers;
let repo: Repo;
let base: string;
let staleRow: string;
const cookies: Record<string, string> = {};

async function person(name: string, isAdmin = false): Promise<User> {
  const made = await createUser(app.db, { username: name, email: `${name}@x.test`, password: "correct horse battery", origin: "seed", isAdmin, trusted: true });
  if (!made.ok) throw new Error(String(made.error));
  cookies[name] = `forge_session=${createSession(app.db, made.value.id).token}`;
  return made.value;
}

beforeAll(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "machine-shell-"));
  app = createApp({ dataDir, port: 0 });
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
  const alice = await person("alice");
  await person("bob");
  const made = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "lab", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const shut = await createRepo(app.db, app.reposRoot, { ownerId: alice.id, name: "shut", visibility: "private" });
  if (!shut.ok) throw new Error(String(shut.error));
  // A row a crashed forge left open, closed when this one boots.
  staleRow = recordStart(app.db, repo.id, "standard", alice.id);
  servers = await serve(app);
  base = servers.url.replace(/^http/, "ws");
});

afterAll(() => {
  servers.stop();
  app.close();
});

const ORIGIN = () => new URL(servers.url).origin;

/** The handshake's answer, as fetch sees it: 101 never comes back to fetch, a refusal does. */
async function handshake(who: string | undefined, origin: string | undefined, path = "/alice/lab/machines/standard/shell", extra: Record<string, string> = {}): Promise<number> {
  const headers: Record<string, string> = {
    ...extra,
    connection: "Upgrade",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
  };
  if (who !== undefined) headers["cookie"] = cookies[who]!;
  if (origin !== undefined) headers["origin"] = origin;
  const res = await fetch(`${ORIGIN()}${path}`, { headers });
  await res.body?.cancel();
  return res.status;
}

function open(who: string, machine = "standard"): Promise<{ ws: WebSocket; seen: () => string }> {
  const ws = new WebSocket(`${base}/alice/lab/machines/${machine}/shell`, {
    headers: { cookie: cookies[who]!, origin: ORIGIN() },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  let text = "";
  ws.addEventListener("message", (e) => {
    text += typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
  });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve({ ws, seen: () => text }));
    ws.addEventListener("error", () => reject(new Error("refused")));
  });
}

async function until(what: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

test("the path names a repository and a machine, or nothing", () => {
  expect(shellTarget("/alice/lab/machines/standard/shell")).toEqual({ owner: "alice", name: "lab", machine: "standard" });
  expect(shellTarget("/alice/lab/machines/Bad;rm/shell")).toBeUndefined();
  expect(shellTarget("/alice/lab/machines/standard/shell/x")).toBeUndefined();
});

test("a resize frame is validated", () => {
  expect(parseControl('{"type":"resize","cols":120,"rows":40}')).toEqual({ cols: 120, rows: 40 });
  expect(parseControl('{"type":"resize","cols":0,"rows":40}')).toBeUndefined();
  expect(parseControl('{"type":"resize","cols":1.5,"rows":40}')).toBeUndefined();
  expect(parseControl('{"type":"resize","cols":9999,"rows":40}')).toBeUndefined();
  expect(parseControl('{"type":"exec","cols":80,"rows":24}')).toBeUndefined();
  expect(parseControl("not json")).toBeUndefined();
});

test("a reader, a stranger, another origin and an unknown machine are refused", async () => {
  expect(await handshake("bob", ORIGIN())).toBe(403);
  expect(await handshake(undefined, ORIGIN())).toBe(403);
  expect(await handshake("alice", "https://evil.test")).toBe(403);
  expect(await handshake("alice", undefined)).toBe(403);
  expect(await handshake("alice", ORIGIN(), "/alice/lab/machines/nope/shell")).toBe(404);
  expect(await handshake("alice", ORIGIN(), "/alice/missing/machines/standard/shell")).toBe(404);
  // A token, even one that may write, never opens a shell.
  expect(await handshake(undefined, ORIGIN(), undefined, { authorization: `Bearer ${tokenFor(app, "alice", "rw")}` })).toBe(403);
  // A reader of a private repository is not told it exists.
  expect(await handshake("bob", ORIGIN(), "/alice/shut/machines/standard/shell")).toBe(404);
  // Only the row a crashed forge left behind, closed at boot.
  expect(lastSessions(app.db, repo.id).map((r) => [r.id, r.endReason])).toEqual([[staleRow, "stopped"]]);
});

test("a writer's session echoes input, applies a resize, reattaches, and is recorded", async () => {
  const first = await open("alice");
  first.ws.send(new TextEncoder().encode("echo hel''lo-shell\n"));
  await until(() => first.seen().includes("hello-shell"));

  first.ws.send(JSON.stringify({ type: "resize", cols: 111, rows: 33 }));
  first.ws.send(new TextEncoder().encode("stty size\n"));
  await until(() => first.seen().includes("33 111"));

  // A second connection joins the same session, and sees its output.
  const second = await open("alice");
  expect(liveSessions(app)).toBe(1);
  first.ws.send(new TextEncoder().encode("echo two''-tabs\n"));
  await until(() => second.seen().includes("two-tabs"));

  const started = lastSessions(app.db, repo.id);
  expect(started).toHaveLength(2);
  expect(started[0]).toMatchObject({ machine: "standard", ownerName: "alice", endedAt: undefined });

  const closed = new Promise((r) => second.ws.addEventListener("close", r));
  first.ws.send(new TextEncoder().encode("exit\n"));
  await closed;
  await until(() => lastSessions(app.db, repo.id)[0]?.endedAt !== undefined);
  expect(lastSessions(app.db, repo.id)[0]).toMatchObject({ endReason: "exit" });
  expect(liveSessions(app)).toBe(0);
});

test("a text frame that is not a resize ends the connection", async () => {
  const { ws } = await open("alice");
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  ws.send("rm -rf /");
  expect(await closed).toBe(1003);
});

test("a session with no keystroke past the idle limit ends, and says so", async () => {
  stopShells(app);
  setShellOptions(app, { idleMs: 150, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
  const { ws } = await open("alice");
  await new Promise((r) => ws.addEventListener("close", r));
  await until(() => lastSessions(app.db, repo.id)[0]?.endReason !== undefined);
  expect(lastSessions(app.db, repo.id)[0]?.endReason).toBe("idle");
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
});

test("a forge that cannot hold a cell refuses the shell", async () => {
  setShellOptions(app, { idleMs: 60_000, contain: "refuse", command: "exec /bin/sh", handshakesPerMinute: 1000 });
  const ws = new WebSocket(`${base}/alice/lab/machines/standard/shell`, {
    headers: { cookie: cookies["alice"]!, origin: ORIGIN() },
  } as unknown as string[]);
  const code = await new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  expect(code).toBe(1011);
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
});

test("a row left open by a forge that stopped is closed as stopped at boot", () => {
  const row = recordStart(app.db, repo.id, "standard", lastSessions(app.db, repo.id)[0]!.ownerId);
  expect(closeStaleSessions(app.db)).toBe(1);
  expect(lastSessions(app.db, repo.id).find((r) => r.id === row)?.endReason).toBe("stopped");
});

test("stopping the forge ends a session as stopped", async () => {
  const { ws } = await open("alice");
  const closed = new Promise((r) => ws.addEventListener("close", r));
  stopShells(app);
  await closed;
  expect(lastSessions(app.db, repo.id)[0]?.endReason).toBe("stopped");
  expect(liveSessions(app)).toBe(0);
});

test("a session ends when its owner can no longer write here", async () => {
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", checkMs: 30, handshakesPerMinute: 1000 });
  const { ws } = await open("alice");
  const closed = new Promise((r) => ws.addEventListener("close", r));
  app.db.run("UPDATE user SET suspended_at = ? WHERE username = 'alice'", [new Date().toISOString()]);
  await closed;
  await until(() => lastSessions(app.db, repo.id)[0]?.endReason !== undefined);
  expect(lastSessions(app.db, repo.id)[0]?.endReason).toBe("revoked");
  expect(liveSessions(app)).toBe(0);
  app.db.run("UPDATE user SET suspended_at = NULL WHERE username = 'alice'");
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
});

test("a keystroke frame past the cap closes the connection", async () => {
  const { ws } = await open("alice");
  const closed = new Promise<number>((r) => ws.addEventListener("close", (e) => r(e.code)));
  ws.send(new Uint8Array(64 * 1024 + 1));
  expect(await closed).toBe(1009);
  stopShells(app);
});

test("one person holds at most a few sessions at once, and a handshake flood is refused", async () => {
  expect(MAX_SESSIONS.person).toBe(3);
  const held = [await open("alice"), await open("alice", "security")];
  expect(liveSessions(app)).toBe(2);
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 0 });
  expect(await handshake("alice", ORIGIN())).toBe(429);
  setShellOptions(app, { idleMs: 60_000, contain: "uncontained", command: "exec /bin/sh", handshakesPerMinute: 1000 });
  for (const h of held) h.ws.close();
  stopShells(app);
});

test("each writer has their own directory, and the cell hides the forge and holds the machine's ceilings", () => {
  const machine = { ...BUILT_IN[0]!, memoryMiB: 2048, cpus: 2 };
  const a = workspace(app, repo, machine, "u1");
  const b = workspace(app, repo, machine, "u2");
  expect(a).not.toBe(b);
  expect(existsSync(join(app.config.dataDir, "machines", repo.id, "standard"))).toBe(true);
  const spec = shellCell(app, a, machine, "machine:x/standard");
  expect(spec.hide).toContain(app.config.dataDir);
  expect(spec.egress).toEqual([]);
  expect(spec.limits.memoryMiB).toBe(2048);
  expect(spec.limits.cpus).toBe(2);
  expect(spec.home).toBe(join(a, "home"));
  expect(spec.terminal).toBe(true);
});

test("the last sessions are read by their index", () => {
  const plan = app.db
    .query("EXPLAIN QUERY PLAN SELECT id FROM machine_sessions WHERE repo_id = ? ORDER BY started_at DESC LIMIT 20")
    .all("r")
    .map((r) => (r as { detail: string }).detail)
    .join("\n");
  expect(plan).toContain("machine_sessions_repo_started");
  expect(plan).not.toContain("TEMP B-TREE");
});

test("the repository's settings show a writer the last sessions, and a reader none", async () => {
  const page = await fetch(`${servers.url}/alice/lab/settings/machines`, { headers: { cookie: cookies["alice"]! } });
  const body = await page.text();
  expect(page.status).toBe(200);
  expect(body).toContain("Last sessions");
  expect(body).toContain("idle too long");
  expect(body).toContain("the shell exited");
  const reader = await fetch(`${servers.url}/alice/lab/settings/machines`, { headers: { cookie: cookies["bob"]! } });
  await reader.body?.cancel();
  expect(reader.status).toBe(403);
});
