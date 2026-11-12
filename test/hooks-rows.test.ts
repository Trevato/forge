/** Settings › Hooks is headings over rows, not cards (#9762). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { createWebhook } from "../src/core/webhooks.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";

async function page(): Promise<string> {
  const html = await (await fetch(`${servers.url}/alice/a/settings/hooks`, { headers: { cookie } })).text();
  return html.slice(html.indexOf("<main"), html.indexOf("</main>"));
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-hooks-rows-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const r = await createRepo(app, u.value, { name: "a", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  repoId = r.value.id;
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("with no hook: two headed blocks, one plain sentence, the add form, no box", async () => {
  const main = await page();
  for (const h of ["Webhooks", "Add a webhook"]) expect(main).toContain(`<h2>${h}</h2>`);
  expect(main).toContain("No webhooks yet.");
  expect(main).toContain('action="/alice/a/settings/hooks"');
  for (const boxed of ['class="card', "card-head", "card-body", 'class="empty', "<table"]) expect(main).not.toContain(boxed);
});

test("a hook is a row with its URL, events, ping and a confirmed delete; the secret is not shown", async () => {
  const made = createWebhook(app.db, { repoId, url: "https://a.example/h", secret: "s3cret-value", kinds: "push" });
  if (!made.ok) throw new Error("hook");
  const main = await page();
  const block = main.slice(main.indexOf("<h2>Webhooks</h2>"), main.indexOf("<h2>Add a webhook</h2>"));
  expect(block).toContain('<ul class="list setting-list">');
  expect(block).toContain("https://a.example/h");
  expect(block).toContain("push");
  expect(block).toContain("No deliveries yet.");
  expect(block).toContain(`/alice/a/settings/hooks/${made.value.webhook.id}/ping`);
  expect(block).toContain(`/-/confirm?to=${encodeURIComponent(`/alice/a/settings/hooks/${made.value.webhook.id}/delete`)}`);
  expect(main).not.toContain("s3cret-value");
  for (const boxed of ['class="card', "card-head", "<table"]) expect(main).not.toContain(boxed);
});
