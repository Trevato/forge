/** `/-/confirm` and the parent sign-in pair name their Server-Timing phases (#5401). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-confirm-parent-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const phases = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(";")[0]!);

test("GET /-/confirm names session and render", async () => {
  const res = await fetch(`${servers.url}/-/confirm?to=/nowhere`);
  await res.arrayBuffer();
  expect(res.status).toBe(404);
  expect(phases(res)).toEqual(expect.arrayContaining(["app", "session", "render"]));
});

test("GET /signin/parent names session and render", async () => {
  const res = await fetch(`${servers.url}/signin/parent`, { redirect: "manual" });
  await res.arrayBuffer();
  expect(res.status).toBe(404);
  expect(phases(res)).toEqual(expect.arrayContaining(["app", "session", "render"]));
});

test("GET /signin/parent/callback names session and render", async () => {
  const res = await fetch(`${servers.url}/signin/parent/callback`, { redirect: "manual" });
  await res.arrayBuffer();
  expect(res.status).toBe(400);
  expect(phases(res)).toEqual(expect.arrayContaining(["app", "session", "render"]));
});

test("the callback names parent for the token exchange", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-confirm-parent-timing-"));
  const parent = createApp({ dataDir: join(dir, "p"), port: 0 });
  const parentServers = await serve(parent);
  const child = createApp({ dataDir: join(dir, "c"), port: 0, parentUrl: parentServers.url, parentLoopback: true });
  const childServers = await serve(child);
  try {
    const made = await createUser(parent.db, {
      origin: "seed",
      username: "alice",
      email: "alice@x.local",
      password: "a-long-family-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const cookie = `forge_session=${createSession(parent.db, made.value.id).token}`;
    const start = await fetch(`${childServers.url}/signin/parent`, { redirect: "manual" });
    expect(start.status).toBe(303);
    expect(phases(start)).toEqual(expect.arrayContaining(["session"]));
    const state = start.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("forge_rp="))!;
    const to = new URL(start.headers.get("location")!);
    const consent = await fetch(`${parentServers.url}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, origin: parentServers.url },
      body: new URLSearchParams({ ...Object.fromEntries(to.searchParams), decision: "allow" }),
    });
    const back = new URL(consent.headers.get("location")!);
    const done = await fetch(`${childServers.url}${back.pathname}${back.search}`, {
      redirect: "manual",
      headers: { cookie: state },
    });
    await done.arrayBuffer();
    expect(done.status).toBe(303);
    expect(phases(done)).toEqual(expect.arrayContaining(["app", "session", "parent"]));
  } finally {
    childServers.stop();
    parentServers.stop();
    child.close();
    parent.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
