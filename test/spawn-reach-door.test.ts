/**
 * A new forge is proven before it is called done (#7959): the spawn result
 * lists the child's home and each app's public address with what came back,
 * through the API and the MCP, and what never answers is an alarm.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { alarmLines } from "../src/crew/notify.ts";
import { listEvents } from "../src/core/events.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ok } from "../src/kernel/result.ts";
import { useChildFetch } from "../src/spawn/clients.ts";
import { usePlacement, useProbe } from "../src/spawn/door.ts";
import { reachAlarms, reachOf, useReach } from "../src/spawn/reach.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let token = "";
/** What the public network answers: the child's home, but a standby page for its app. */
const answers = new Map<string, () => Response>();
let n = 0;

const spawn = (name: string) =>
  fetch(`${servers.url}/api/v1/forges`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, apps: ["alice/notes"], dryRun: false }),
  });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-reach-door-"));
  app = createApp({ dataDir, url: "https://forge.test", port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("user");
  token = createToken(app.db, a.value.id, "rw", "rw").token;
  const repo = await createRepo(app, a.value, { name: "notes" });
  if (!repo.ok) throw new Error("repo");
  useProbe(app, () => async () => true);
  usePlacement(app, {
    place: async (plan) => ok({ url: `https://${plan.name}--forge.test`, bodyId: `fake-${++n}` }),
    retire: async () => ok(),
  });
  useChildFetch(app, async () => Response.json({ claimed: false }));
  useReach(app, {
    settleMs: 0,
    pollMs: 1,
    confirmMs: 0,
    fetch: async (url) => (answers.get(url) ?? (() => new Response("<h1>standby</h1>", { status: 200 })))(),
  });
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the spawn result lists each address with its result; a standby page is a failure, not green", async () => {
  answers.set("https://kid--forge.test/api/v1/forge", () => Response.json({ claimed: false }));
  const res = await spawn("kid");
  expect(res.status).toBe(201);
  const made = (await res.json()) as any;
  expect(made.reach.ok).toBe(false);
  expect(made.reach.says).toContain("Running, not reachable: notes answered 200, not by the app");
  expect(made.reach.proofs).toEqual([
    { label: "home", url: "https://kid--forge.test/api/v1/forge", ok: true, status: 200, says: "answered 200" },
    { label: "notes", url: "https://notes--kid--forge.test/", ok: false, status: 200, says: "answered 200, not by the app" },
  ]);
  // The never-answering app is the alarm, once its time to come up is over.
  for (let i = 0; i < 100 && reachAlarms(app).length === 0; i++) await Bun.sleep(20);
  expect(reachAlarms(app).map((a) => a.key)).toEqual(["unreachable"]);
  expect(listEvents(app.db, { kind: "forge.child_unreachable", limit: 5 })).toHaveLength(1);
  expect(reachOf(app, "kid")?.alarmed).toBe(true);
});

test("/forges lists the same results, and the MCP spawn says it", async () => {
  const list = await fetch(`${servers.url}/api/v1/forges`, { headers: { authorization: `Bearer ${token}` } });
  expect(list.status).toBe(200);
  answers.set("https://lamp--forge.test/api/v1/forge", () => Response.json({ claimed: false }));
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "spawn", arguments: { name: "lamp", apps: ["alice/notes"], dryRun: false } } }),
  });
  const text = ((await res.json()) as any).result.content[0].text as string;
  expect(text).toContain("Running, not reachable");
  const forges = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "forges", arguments: {} } }),
  });
  const body = JSON.parse(((await forges.json()) as any).result.content[0].text) as { forges: { name: string; reach: { ok: boolean } }[] };
  expect(body.forges.find((f) => f.name === "kid")?.reach.ok).toBe(false);
});

test("/forges says Running, not reachable with each address and its result", async () => {
  const page = await fetch(`${servers.url}/forges`, { headers: { authorization: `Bearer ${token}` } });
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Running, not reachable: notes answered 200, not by the app");
  expect(html).toContain('data-proof="failed"');
  expect(html).toContain("notes--kid--forge.test/");
  expect(html).toContain('data-proof="ok"');
});

test("the owner is paged: the notifier's alarm lines carry the unreachable child", async () => {
  const admin = getUserByName(app.db, "alice")!;
  const lines = alarmLines(app, admin);
  expect(lines.map((l) => l.line)).toContainEqual(expect.stringContaining("kid is running, not reachable"));
  expect(lines.find((l) => l.line.startsWith("kid"))?.link).toBe("/forges");
});
