/** Settings › Webhooks: Redeliver on a failed delivery, admin only, same-origin only (#8076). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook, recentDeliveries } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;
let owner = "", reader = "";
let hookId = "", deliveryId = "";

const state = () => recentDeliveries(app.db, hookId, 10)[0]?.state;
const action = () => `/own/h/settings/hooks/${hookId}/deliveries/${deliveryId}/redeliver`;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-hook-redeliver-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string) => {
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "correct-horse-battery",
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const o = await mk("own");
  const r = await mk("reader");
  owner = `forge_session=${createSession(app.db, o.id).token}`;
  reader = `forge_session=${createSession(app.db, r.id).token}`;
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: o.id, name: "h", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const hook = createWebhook(app.db, { repoId: repo.value.id, url: "https://example.com/h" });
  if (!hook.ok) throw new Error("hook");
  hookId = hook.value.webhook.id;
  app.bus.append({ kind: "push", repoId: repo.value.id });
  app.db.query("UPDATE webhook_delivery SET state = 'failed', attempts = 3, last_status = 500").run();
  deliveryId = recentDeliveries(app.db, hookId, 1)[0]!.id;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

function post(cookie: string, origin: string | null = servers.url) {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", cookie };
  if (origin !== null) headers.origin = origin;
  return fetch(servers.url + action(), { method: "POST", headers, body: "", redirect: "manual" });
}

test("a failed delivery shows Redeliver to the admin only", async () => {
  const page = await (await fetch(`${servers.url}/own/h/settings/hooks`, { headers: { cookie: owner } })).text();
  expect(page).toContain(action());
  expect(page).toContain("Redeliver");
  const other = await fetch(`${servers.url}/own/h/settings/hooks`, { headers: { cookie: reader }, redirect: "manual" });
  expect(await other.text()).not.toContain(action());
});

test("a reader's or cross-origin POST changes nothing", async () => {
  expect((await post(reader)).status).toBe(404);
  expect((await post(owner, "https://evil.example")).status).toBe(403);
  expect(state()).toBe("failed");
});

test("the admin's POST makes it pending and redirects back; a pending row has no button", async () => {
  const res = await post(owner);
  expect(res.status).toBe(303);
  expect(new URL(res.headers.get("location")!, servers.url).pathname).toBe("/own/h/settings/hooks");
  expect(state()).toBe("pending");
  const page = await (await fetch(`${servers.url}/own/h/settings/hooks`, { headers: { cookie: owner } })).text();
  expect(page).not.toContain(action());
  // a second POST is refused with the notice and changes nothing
  expect((await post(owner)).status).toBe(303);
  expect(state()).toBe("pending");
});
