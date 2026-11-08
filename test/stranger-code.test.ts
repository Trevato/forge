/** #9513: strangers' code pages wait in a line of their own; a signed-in reader is never queued behind them. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { Gate, gitGate } from "../src/git/env.ts";
import type { Ctx } from "../src/http/context.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { STRANGER_CODE_QUEUE, strangerCode, strangerCodeGate, strangerShare } from "../src/http/stranger_code.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}${path}`, { headers: { "x-forwarded-for": "10.9.0.1", ...headers }, redirect: "manual" });
const within = <T>(p: Promise<T>, ms: number): Promise<T | "waiting"> =>
  Promise.race([p, Bun.sleep(ms).then(() => "waiting" as const)]);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-stranger-code-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", isAdmin: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const r = await createRepo(app, alice, { name: "open", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "open")!, { message: "Start", files: [{ path: "a.txt", content: "hi\n" }] });
  if (!c.ok) throw new Error(String(c.error));
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("strangers together hold at most half the git pool, leaving the rest for people", () => {
  expect(strangerShare(8, undefined)).toBe(4);
  expect(strangerShare(1, undefined)).toBe(1);
  expect(strangerShare(gitGate.limit, undefined)).toBeLessThan(gitGate.limit);
  expect(STRANGER_CODE_QUEUE).toBe(256);
});

test("FORGE_STRANGER_CODE_CONCURRENCY fixes the share; nonsense is ignored", () => {
  expect(strangerShare(8, "3")).toBe(3);
  expect(strangerShare(8, "2.7")).toBe(2);
  for (const bad of ["0", "-1", "lots", ""]) expect(strangerShare(8, bad)).toBe(4);
});

const anon = { auth: { user: undefined } } as unknown as Ctx;
const signedIn = { auth: { user: { id: "u" } } } as unknown as Ctx;

test("with the line full, the next stranger is told 503 with Retry-After; a signed-in reader still goes in", async () => {
  const pool = new Gate(2);
  const gate = new Gate(1);
  const page = strangerCode(() => new Response("page"), { gate, pool, queue: 2 });
  const release = await gate.acquire();
  const waiting = [page(anon), page(anon)];
  expect(gate.stats().waiting).toBe(2);
  const refused = await page(anon);
  expect(refused.status).toBe(503);
  expect(refused.headers.get("retry-after")).toBe("1");
  expect(gate.stats().waiting).toBe(2);
  expect((await page(signedIn)).status).toBe(200);
  release();
  for (const w of waiting) expect((await w).status).toBe(200);
  expect((await page(anon)).status).toBe(200);
});

test("the strangers' share follows a resize of the git pool", async () => {
  const pool = new Gate(8);
  const gate = new Gate(4);
  const page = strangerCode(() => new Response("page"), { gate, pool, queue: 2 });
  pool.resize(2);
  await page(anon);
  expect(gate.limit).toBe(1);
  pool.resize(16);
  await page(anon);
  expect(gate.limit).toBe(8);
});

test("with every stranger permit held, an anonymous code page waits while a signed-in one, / and the repository home answer", async () => {
  const held = await Promise.all(Array.from({ length: strangerCodeGate.limit }, () => strangerCodeGate.acquire()));
  try {
    const strangers = ["/alice/open/tree/main", "/alice/open/blob/main/a.txt", "/alice/open/raw/main/a.txt"].map((p) => get(p));
    for (const s of strangers) expect(await within(s, 300)).toBe("waiting");
    expect(strangerCodeGate.stats().waiting).toBe(3);

    for (const path of ["/alice/open/tree/main", "/alice/open/blob/main/a.txt", "/alice/open/raw/main/a.txt", "/", "/alice/open"]) {
      const began = performance.now();
      const r = await within(get(path, { cookie }), 2000);
      expect(r).not.toBe("waiting");
      if (r !== "waiting") expect(r.status).toBe(200);
      expect(performance.now() - began).toBeLessThan(2000);
    }

    held.forEach((release) => release());
    held.length = 0;
    for (const s of strangers) expect((await s).status).toBe(200);
  } finally {
    held.forEach((release) => release());
  }
});

test("a queue of strangers' cached pages lets the event loop take new requests between them", async () => {
  const gate = new Gate(1);
  let done = 0;
  const page = strangerCode(
    () => {
      const until = performance.now() + 5;
      while (performance.now() < until) {} // a page's synchronous render
      done++;
      return new Response("cached");
    },
    { gate, pool: new Gate(2), queue: 100 },
  );
  const strangers = Array.from({ length: 20 }, () => page(anon));
  // Stands for a person's request arriving: a callback of the event loop.
  let doneWhenSeen = -1;
  setImmediate(() => (doneWhenSeen = done));
  await Promise.all(strangers);
  expect(done).toBe(20);
  expect(doneWhenSeen).toBeGreaterThanOrEqual(0);
  expect(doneWhenSeen).toBeLessThan(20);
});

test("a synchronous burst cannot overshoot the line: exactly the permits plus the queue go in, the rest are told 503", async () => {
  const gate = new Gate(2);
  const page = strangerCode(() => new Response("page"), { gate, pool: new Gate(4), queue: 3 });
  // Thirty strangers arrive in one turn of the event loop, before any is answered.
  const burst = Array.from({ length: 30 }, () => page(anon));
  expect(gate.stats().active).toBe(2);
  expect(gate.stats().waiting).toBe(3);
  const statuses = (await Promise.all(burst)).map((r) => r.status);
  expect(statuses.filter((s) => s === 200).length).toBe(5);
  expect(statuses.filter((s) => s === 503).length).toBe(25);
});
