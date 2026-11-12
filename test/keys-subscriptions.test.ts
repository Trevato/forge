/** The subscriptions list joins the shell's j/k row traversal: one data-nav per account row. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-subs-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () =>
  (await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/g;

test("each account row is one data-nav row", async () => {
  const before = (await get()).match(NAV)?.length ?? 0;
  for (const name of ["work", "home"])
    expect(addSubscription(app.db, dataDir, { name, token: `sk-ant-${name}-token-0123456789` }).ok).toBe(true);
  const text = await get();
  expect(text).toContain("work");
  expect(text.match(NAV)?.length).toBe(before + 2);
});
