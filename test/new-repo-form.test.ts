/** /new reads like the new issue form: one heading, no card, one error line. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-new-repo-form-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
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

test("/new has a heading and a name field and no card", async () => {
  const html = await (await fetch(`${servers.url}/new`, { headers: { cookie } })).text();
  expect(html).toContain("New repository");
  expect(html).toContain('name="name"');
  expect(html).not.toMatch(/class="[^"]*\bcard\b/);
});

test("a refused name shows its error once, escaped", async () => {
  const res = await fetch(`${servers.url}/new`, {
    method: "POST",
    headers: { origin: servers.url, cookie },
    body: new URLSearchParams({ owner: "alice", name: "<b>bad", description: "<i>x", visibility: "private" }),
  });
  expect(res.status).toBe(422);
  const html = await res.text();
  expect(html.match(/class="error"/g)?.length).toBe(1);
  expect(html).not.toContain("<b>bad");
  expect(html).toContain("&lt;b&gt;bad");
  expect(html).not.toMatch(/class="[^"]*\bcard\b/);
});
