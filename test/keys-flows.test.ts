/** The all-flows list joins the shell's j/k row traversal (#10407): one data-nav per linked row, none on the empty page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-flows-"));
  app = createApp({ dataDir, port: 0, forgeRepo: "acme/forge" });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  const alice = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'alice'").get()!.id;
  const up = app.db.query("INSERT INTO repo_upstream (repo_id, url, branch, enabled, checked_at, behind, error, by_id, updated_at) VALUES (?1, ?2, 'main', 1, '2026-11-08T00:00:00Z', 0, '', ?3, '2026-11-08T00:00:00Z')");
  for (const i of [1, 2, 3]) {
    app.db.query("INSERT INTO repo (id, owner_id, name) VALUES (?1, ?2, ?3)").run(`r${i}`, alice, `repo${i}`);
    up.run(`r${i}`, `https://example.com/${i}.git`, alice);
  }
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

const get = async (q = "") => (await fetch(`${servers.url}/admin/flows${q}`, { headers: { cookie } })).text();
const NAV = /class="row"[^>]*data-nav tabindex="-1"/;

test("each flow line is one data-nav row whose first link is its repository's flows", async () => {
  const text = await get();
  const rows = text.split("<li").filter((li) => NAV.test(li));
  expect(rows.length).toBe(3);
  for (const [i, n] of [1, 2, 3].entries()) {
    expect(rows[i]).toContain(`href="/alice/repo${n}/flows"`);
    expect(rows[i]!.match(/<a href="([^"]+)"/)![1]).toBe(`/alice/repo${n}/flows`);
  }
});

test("the empty list draws no flow data-nav row", async () => {
  const text = await get("?kind=scan");
  expect(text).toContain("No flow lines match.");
  expect(text).not.toMatch(NAV);
});
