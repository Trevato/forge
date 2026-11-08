/** /settings/origins is headings over rows: settings blocks, no `.card`. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createOrigin, linkRepoToOrigin } from "../src/core/origins.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { components } from "../src/web/style/components.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-origins-shape-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  servers = await serve(app);
  const r = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (r.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("the origins page has settings blocks with headings and no card", async () => {
  const res = await fetch(`${servers.url}/settings/origins`, { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).not.toMatch(/class="(?:[^"]*\s)?card(?:\s[^"]*)?"/);
  for (const h of ["Connected origins", "Trusted internal hosts", "Connect an origin"]) {
    expect(body).toMatch(new RegExp(`<section class="settings-block"[^>]*>\\s*<h2>${h}</h2>`));
  }
  expect(body).toContain(
    "No origins connected: connect another forge, GitHub, a Forgejo\n            instance or a Gitea instance below.",
  );
  // One sentence: no full stop before its end.
  const empty = body.split("<h2>Connected origins</h2>")[1]!.split("</p>")[0]!;
  expect(empty.replace(/<[^>]+>/g, "").trim().split(". ").length).toBe(1);
  expect(body).toContain('id="connect"');
});

test("connected origins are rows of one list, with no wrapper box", async () => {
  const alice = getUserByName(app.db, "alice")!;
  for (const login of ["one", "two"]) {
    const o = createOrigin(app.db, root, {
      userId: alice.id,
      kind: "forgejo",
      apiUrl: `https://git.example.com/api/v1/${login}`,
      webUrl: "https://git.example.com",
      login,
      token: "t0ken",
    });
    expect(o.ok).toBe(true);
  }
  const body = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
  expect(body).not.toContain("origin-item");
  const block = body.split("<h2>Connected origins</h2>")[1]!.split("</section>")[0]!;
  expect(block.match(/<ul class="list setting-list" data-origins>/g)?.length).toBe(1);
  expect(block.match(/<li[ >]/g)!.length).toBeGreaterThanOrEqual(2);
  expect(block).toContain("Sync now");
  expect(block).toContain("Disconnect");
});

test("an origin's error and notes render inside its own row", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const o = createOrigin(app.db, root, {
    userId: alice.id,
    kind: "forgejo",
    apiUrl: "https://broken.example.com/api/v1",
    webUrl: "https://broken.example.com",
    login: "broken",
    token: "t0ken",
    software: "forge",
  });
  if (!o.ok) throw new Error("origin");
  app.db
    .query("UPDATE origin SET last_error = ?1 WHERE id = ?2")
    .run("upstream said 502", o.value.id);
  const body = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
  const block = body.split("<h2>Connected origins</h2>")[1]!.split("</section>")[0]!;
  const li = block
    .split(/<li[ >]/)
    .slice(1)
    .find((part) => part.includes("broken"))!
    .split("</li>")[0]!;
  const after = li.split('<div class="row-after">')[1]!;
  expect(after).toContain(`id="origin-${o.value.id}-err"`);
  expect(after).toContain("upstream said 502");
  expect(after).toContain("Another forge.");
  expect(after).toContain("Sync now");
});

test("a frozen mirror is listed under a Frozen mirrors heading", async () => {
  const alice = getUserByName(app.db, "alice")!;
  const repo = await createRepo(app.db, app.reposRoot, {
    ownerId: alice.id,
    name: "frozen1",
    visibility: "public",
  });
  if (!repo.ok) throw new Error("repo");
  const o = createOrigin(app.db, root, {
    userId: alice.id,
    kind: "forgejo",
    apiUrl: "https://gone.example.com/api/v1",
    webUrl: "https://gone.example.com",
    login: "gone",
    token: "t0ken",
  });
  if (!o.ok) throw new Error("origin");
  linkRepoToOrigin(app.db, repo.value.id, {
    originId: o.value.id,
    fullName: "them/up",
    remoteId: "1",
    htmlUrl: "https://gone.example.com/them/up",
  });
  app.db.query("DELETE FROM origin WHERE id = ?1").run(o.value.id);
  const body = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie } })).text();
  expect(body).toMatch(/<section class="settings-block"[^>]*>\s*<h2>Frozen mirrors<\/h2>/);
  expect(body).toContain("them/up");
});

test("an origin's after slot is a full-width block under the row, so it fits a 390 px phone", () => {
  const rule = components
    .split("\n")
    .find((l) => l.startsWith(".setting-list[data-origins] > li.has-after > .row-after"));
  expect(rule).toBeDefined();
  expect(rule).toContain("flex-basis: 100%");
  expect(rule).toContain("display: block");
  expect(rule).toContain("min-width: 0");
  expect(rule).toContain("overflow-wrap: anywhere");
});
