/**
 * #7982: removing a cloud account deletes its sealed token, so Settings ›
 * Cloud links Remove to /-/confirm, which names the account and posts the
 * removal on the second step with the account in the query.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addAccount, net } from "../src/actions/cloud.ts";
import { listCloudAccounts } from "../src/core/cloud_account.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const TOKEN = "do-live-4Hn8RsWq2Lm6Tx9cVb3K";

/** A fake DigitalOcean that accepts TOKEN and answers like the real API. */
net.fetch = async (url, init) => {
  const bad = !String((init?.headers as any)?.authorization).includes(TOKEN);
  const u = new URL(url);
  const reply = (o: unknown) => new Response(JSON.stringify(o), { status: bad ? 401 : 200 });
  if (u.pathname === "/v2/account") return reply({ account: { email: "o@x.test", status: "active" } });
  if (u.pathname === "/v2/projects") return reply({ projects: [] });
  if (u.pathname === "/v2/droplets") return reply({ meta: { total: 0 }, droplets: [] });
  if (u.pathname === "/v2/volumes") return reply({ volumes: [] });
  if (u.pathname === "/v2/reserved_ips") return reply({ reserved_ips: [] });
  return new Response("{}", { status: 404 });
};

let dataDir: string;
let app: App;
let servers: Servers;
let cookie: string;
const to = "/settings/cloud/remove?provider=digitalocean&name=main";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-confirm-cloud-remove-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "a@f.test",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!admin.ok) throw new Error("user");
  const added = await addAccount(app, admin.value, "digitalocean", "main", TOKEN);
  if (!added.ok) throw new Error(JSON.stringify(added.error));
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("Settings › Cloud sends Remove through the confirm page", async () => {
  const page = await (await fetch(`${servers.url}/settings/cloud`, { headers: { cookie } })).text();
  expect(page).toContain(`href="/-/confirm?to=${encodeURIComponent(to)}"`);
  expect(page).not.toContain(`action="/settings/cloud/remove"`);
});

test("the confirm page names the account and refuses a crafted target", async () => {
  const confirm = await fetch(`${servers.url}/-/confirm?to=${encodeURIComponent(to)}`, { headers: { cookie } });
  expect(confirm.status).toBe(200);
  const body = await confirm.text();
  expect(body).toContain("Remove the digitalocean account main?");
  expect(body).toContain("Its sealed token is deleted from this forge.");
  expect(body).toContain(`action="${to.replace("&", "&amp;")}"`);

  const crafted = `${to}&back=/elsewhere`;
  const refused = await fetch(`${servers.url}/-/confirm?to=${encodeURIComponent(crafted)}`, { headers: { cookie } });
  expect(refused.status).toBe(404);
});

test("the POST from the confirm page removes the account", async () => {
  expect(listCloudAccounts(app.db).map((a) => a.name)).toEqual(["main"]);
  const res = await fetch(`${servers.url}${to}`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: "",
  });
  expect(res.status).toBe(303);
  expect(listCloudAccounts(app.db)).toEqual([]);
});
