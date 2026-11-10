/** The webhooks list joins the shell's j/k row traversal (#10429): one data-nav per hook, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-hooks-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=dev`;
  const none = await createRepo(app, alice, { name: "none", visibility: "public" });
  const some = await createRepo(app, alice, { name: "some", visibility: "public" });
  if (!none.ok || !some.ok) throw new Error("repo");
  for (const n of [1, 2]) createWebhook(app.db, { repoId: some.value.id, url: `https://h${n}.example/hook` });
}, 60_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (name: string) =>
  (await fetch(`${servers.url}/alice/${name}/settings/hooks`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/g;

test("each webhook is one data-nav row", async () => {
  const text = await get("some");
  expect(text).toContain("https://h2.example/hook");
  expect(text.match(NAV)?.length).toBe(2);
});

test("the empty webhooks page draws no data-nav row", async () => {
  const text = await get("none");
  expect(text).toContain("No webhooks yet");
  expect(text).not.toMatch(NAV);
});
