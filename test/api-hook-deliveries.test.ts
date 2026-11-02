/** GET /api/v1/repos/:owner/:name/hooks/:id/deliveries (#7870). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let adminTok = "";
let readTok = "";
let otherTok = "";
let hookA = "";
let hookB = "";
let secretA = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-hook-deliveries-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob", false);
  const ra = await createRepo(app, alice, { name: "a", visibility: "public" });
  const rb = await createRepo(app, alice, { name: "b", visibility: "public" });
  if (!ra.ok || !rb.ok) throw new Error("repo");
  const a = createWebhook(app.db, { repoId: ra.value.id, url: "https://a.example/h" });
  const b = createWebhook(app.db, { repoId: rb.value.id, url: "https://b.example/h" });
  if (!a.ok || !b.ok) throw new Error("hook");
  hookA = a.value.webhook.id;
  hookB = b.value.webhook.id;
  secretA = a.value.secret;
  app.bus.append({ kind: "push", repoId: ra.value.id });
  app.bus.append({ kind: "push", repoId: ra.value.id });
  const rows = app.db
    .query<{ id: string }, [string]>("SELECT id FROM webhook_delivery WHERE webhook_id = ?1 ORDER BY id")
    .all(hookA);
  app.db.query("UPDATE webhook_delivery SET state='ok', attempts=1, last_status=200 WHERE id=?1").run(rows[0]!.id);
  app.db
    .query("UPDATE webhook_delivery SET state='failed', attempts=3, last_status=NULL, last_error='refused: private address' WHERE id=?1")
    .run(rows[1]!.id);
  adminTok = createToken(app.db, alice.id, "t", "admin").token;
  readTok = createToken(app.db, alice.id, "r", "ro").token;
  otherTok = createToken(app.db, bob.id, "o", "admin").token;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string, tok: string) =>
  fetch(`${servers.url}${path}`, { headers: { authorization: `Bearer ${tok}` } });

test("an admin lists both deliveries, newest first, with status and reason", async () => {
  const res = await get(`/api/v1/repos/alice/a/hooks/${hookA}/deliveries`, adminTok);
  expect(res.status).toBe(200);
  const text = await res.text();
  const items = JSON.parse(text).items;
  expect(items).toHaveLength(2);
  expect(items[0]).toMatchObject({ state: "failed", attempts: 3, lastStatus: null, lastError: "refused: private address", kind: "push" });
  expect(items[1]).toMatchObject({ state: "ok", attempts: 1, lastStatus: 200, lastError: null });
  expect(Object.keys(items[0]).sort()).toEqual(["attempts", "id", "kind", "lastError", "lastStatus", "state"]);
  expect(secretA.length).toBeGreaterThan(0);
  expect(text).not.toContain(secretA);
});

test("a non-admin, a read-only token and another repository's hook are 404", async () => {
  expect((await get(`/api/v1/repos/alice/a/hooks/${hookA}/deliveries`, otherTok)).status).toBe(404);
  expect((await get(`/api/v1/repos/alice/a/hooks/${hookA}/deliveries`, readTok)).status).toBe(404);
  const cross = await get(`/api/v1/repos/alice/a/hooks/${hookB}/deliveries`, adminTok);
  const missing = await get(`/api/v1/repos/alice/a/hooks/nope/deliveries`, adminTok);
  expect(cross.status).toBe(404);
  expect(await cross.text()).toBe(await missing.text());
});

test("no credentials is 401", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/a/hooks/${hookA}/deliveries`);
  expect(res.status).toBe(401);
});
