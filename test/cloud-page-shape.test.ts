/** Settings › Cloud is headings over rows, not cards (#9793). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-cloud-shape-"));
  app = createApp({ dataDir: dir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("an admin sees headed sections and no card; with no account one sentence says how to add one", async () => {
  const page = await (await fetch(`${servers.url}/settings/cloud`, { headers: { cookie } })).text();
  const main = page.slice(page.indexOf("<main"), page.indexOf("</main>"));
  for (const h of ["Cloud accounts", "Add an account", "Every read"]) expect(main).toContain(`<h2>${h}</h2>`);
  expect(main).toContain('<section class="settings-block">');
  expect(main).not.toContain('class="card');
  expect(main).not.toContain("card-body");
  expect(main).toContain("No cloud account is sealed yet. Add one below");
  expect(main).toContain('action="/settings/cloud"');
});
