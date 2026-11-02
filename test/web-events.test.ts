/** The events page reads `eventsPage` as MCP `events` does: 50 a page, newest first, as the reader may see. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let pub: Repo;
let priv: Repo;
let ownerCookie = "";
let bobCookie = "";

const get = (path: string, cookie?: string) =>
  fetch(`${servers.url}${path}`, { headers: cookie ? { cookie } : {} });

const titles = (page: string): string[] =>
  [...page.matchAll(/class="row-title"\s*>([^<]*)<\/span/g)].map((m) => m[1]!);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-web-events-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  servers = await serve(app);
  for (const [name, visibility] of [["pub", "public"], ["priv", "private"]] as const)
    if (!(await createRepo(app, alice, { name, visibility })).ok) throw new Error("repo failed");
  pub = getRepo(app.db, "alice", "pub")!;
  priv = getRepo(app.db, "alice", "priv")!;
  const bob = await createUser(app.db, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase", origin: "seed", trusted: true });
  if (!bob.ok) throw new Error("bob failed");
  ownerCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.value.id).token}`;
  app.db.query("DELETE FROM event WHERE repo_id IN (?1, ?2)").run(pub.id, priv.id);
  for (let n = 1; n <= 60; n++)
    app.bus.append({ kind: "issue.opened", repoId: pub.id, actorId: alice.id, payload: { number: n } });
  app.bus.append({ kind: "issue.opened", repoId: priv.id, actorId: alice.id, payload: { number: 1 } });
  app.bus.append({
    kind: "webhook.created",
    repoId: pub.id,
    actorId: alice.id,
    payload: { url: "https://hooks.example/secret-token" },
  });
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("the first page holds 50 events newest first and the cursor reaches the rest", async () => {
  const first = await (await get("/alice/pub/events", bobCookie)).text();
  const rows = titles(first);
  expect(rows.length).toBe(50);
  // bob may not see the webhook, so the newest he sees is issue #60.
  expect(rows[0]).toBe("alice opened an issue: #60");
  expect(rows[49]).toBe("alice opened an issue: #11");
  expect(first).toContain('href="/alice/pub/issues/60"');
  const next = first.match(/href="(\/alice\/pub\/events\?cursor=[^"]+)"/)?.[1];
  expect(next).toBeDefined();
  const second = titles(await (await get(next!.replaceAll("&amp;", "&"), bobCookie)).text());
  expect(second.length).toBe(10);
  expect(second[0]).toBe("alice opened an issue: #10");
  expect(second[9]).toBe("alice opened an issue: #1");
});

test("a reader does not see the webhook; the admin does", async () => {
  const reader = await (await get("/alice/pub/events", bobCookie)).text();
  expect(reader).not.toContain("secret-token");
  expect(reader).not.toContain("added a webhook");
  const admin = await (await get("/alice/pub/events", ownerCookie)).text();
  expect(admin).toContain("added a webhook");
  expect(titles(admin).length).toBe(50);
});

test("a stranger to a private repository gets 404, the owner the page", async () => {
  expect((await get("/alice/priv/events")).status).toBe(404);
  expect((await get("/alice/priv/events", bobCookie)).status).toBe(404);
  expect((await get("/alice/priv/events", ownerCookie)).status).toBe(200);
});

test("a malformed cursor is refused", async () => {
  expect((await get("/alice/pub/events?cursor=a%20b", bobCookie)).status).toBe(404);
});

test("a push row links to the commits, an event with no page is a row without a link", async () => {
  expect((await createRepo(app, alice, { name: "mix", visibility: "public" })).ok).toBe(true);
  const mix = getRepo(app.db, "alice", "mix")!;
  app.db.query("DELETE FROM event WHERE repo_id = ?1").run(mix.id);
  app.bus.append({ kind: "webhook.created", repoId: mix.id, actorId: alice.id, payload: { url: "https://hooks.example/x" } });
  app.bus.append({
    kind: "push",
    repoId: mix.id,
    actorId: alice.id,
    payload: { updates: [{ ref: "refs/heads/trunk" }] },
  });
  const page = await (await get("/alice/mix/events", ownerCookie)).text();
  expect(page).toMatch(/<a href="\/alice\/mix\/commits"[^>]*>[\s\S]*?: trunk/);
  const hook = page.split("<li").find((li) => li.includes("added a webhook"))!.split("</li>")[0]!;
  expect(hook).not.toContain("<a ");
  expect(hook).toContain('<div class="row"');
});

test("the repository header has an Events tab, the palette an Events entry", async () => {
  const page = await (await get("/alice/pub/events", bobCookie)).text();
  expect(page).toMatch(/<a[^>]*href="\/alice\/pub\/events"[^>]*>[\s\S]*?Events/);
  expect(page).toContain("pub — Events");
  const code = await (await get("/alice/pub", bobCookie)).text();
  expect(code).toMatch(/<a[^>]*href="\/alice\/pub\/events"/);
});

test("a guest reads a public repository's events; the palette lists Events once", async () => {
  const res = await get("/alice/pub/events");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("alice opened an issue: #60");
  for (const path of ["/alice/pub", "/alice/pub/events"]) {
    const page = await (await get(path, bobCookie)).text();
    expect(page.split("pub — Events").length - 1).toBe(1);
  }
});
