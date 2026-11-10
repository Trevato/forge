/**
 * Every link in the account menu and home's Now line lands on a page that is
 * its label, and each word of the Now line opens exactly the rows it counts (#8743).
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { NOW_LISTED, NOW_STAGES, NOW_WORDS, readNowRows } from "../src/flow/now_rows.ts";
import { pipelineNow } from "../src/web/studio/living.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { nowScreen, entry as nowEntry } from "../src/tui/screens/nowlist.ts";
import { repoListScreen, entry as reposEntry } from "../src/tui/screens/repolist.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let rootCookie: string;
let aliceCookie: string;
let alice: User;

const get = (path: string, cookie: string) => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
const hrefs = (html: string, from: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>/g)].map((m) => m[1]!).filter((h) => h.startsWith(from));

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-now-links-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, allowReserved: true, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
    if (!r.ok) throw new Error(r.error);
    promote(app.db, r.value);
    return r.value;
  };
  const root = await mk("root", true);
  rootCookie = `forge_session=${createSession(app.db, root.id).token}`;
  alice = await mk("alice");
  aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const pull = (title: string) => {
    const made = createIssue(app.db, { repoId: repo.value.id, authorId: alice.id, title, kind: "pull" });
    if (!made.ok) throw new Error(made.error);
    app.db
      .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', ?, 'b', 'h')")
      .run(made.value.id, `h-${title}`);
    return made.value;
  };
  const run = (kind: string, state: string, issueId: string | null, extra: { reason?: string; env?: string; serving?: boolean } = {}) =>
    app.db
      .query("INSERT INTO run (id, repo_id, kind, issue_id, env, state, reason, serving_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), repo.value.id, kind, issueId, extra.env ?? "", state, extra.reason ?? "", extra.serving ? new Date().toISOString() : null);
  const a = pull("Checked pull");
  const b = pull("Reviewed pull");
  const c = pull("Approved pull");
  run("check", "queued", a.id);
  run("check", "running", a.id);
  run("agent", "running", b.id, { reason: "review" });
  run("deploy", "ok", null, { env: "production", serving: true });
  app.db.query("INSERT INTO review (id, issue_id, author_id, state) VALUES (?, ?, ?, 'approved')").run(crypto.randomUUID(), c.id, alice.id);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("each word of the Now line opens a page titled for it, listing as many rows as the number on home", async () => {
  const home = await (await get("/", rootCookie)).text();
  const now = pipelineNow(app.db, Date.now() + 10_000);
  const line = home.slice(home.indexOf('id="now-line"'));
  for (const stage of NOW_STAGES) {
    const link = line.match(new RegExp(`<a href="([^"]+)"><strong>(\\d+)</strong> ${stage}</a>`));
    expect(link, stage).not.toBeNull();
    expect(link![1]).toBe(`/now/${stage}`);
    const res = await get(link![1]!, rootCookie);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain(`<h1>${NOW_WORDS[stage]}</h1>`);
    const counted = Number(link![2]);
    expect(counted).toBe(now[stage]);
    expect(counted).toBeGreaterThan(0);
    expect(readNowRows(app.db, stage).total).toBe(counted);
    expect(readNowRows(app.db, stage).rows.length).toBe(counted);
    expect(page).toContain(`<strong>${counted}</strong>`);
    expect(hrefs(page, "/alice/notes").length).toBe(counted);
  }
});

test("a person who is not a site admin gets no Now pages, and an unknown stage is not found", async () => {
  expect((await get("/now/check", aliceCookie)).status).toBe(404);
  expect((await get("/now/nope", rootCookie)).status).toBe(404);
});

/** What each account-menu label's page calls itself (its <title>, before " · forge"). A label with no entry fails the test. */
const MENU_TITLES: Record<string, string> = {
  "Your profile": "root",
  Repositories: "Your repositories",
  Apps: "Apps",
  Notes: "Notes",
  Talk: "Talk",
  Explore: "Explore",
  Packs: "Forge packs",
  Displays: "Displays",
  Map: "Map",
  "New app": "New app",
  "New repository": "New repository",
  Migrate: "Migrate",
  "New forge": "New forge",
  Settings: "Settings",
  "Access codes": "Access codes",
  "Computer keys": "Computer keys",
  "Connected accounts": "Connected accounts",
  Crew: "Crew",
  Boards: "Boards",
  "System memory": "System",
};

test("every link in the account menu lands on a page that is its label", async () => {
  const home = await (await get("/", rootCookie)).text();
  const menu = home.slice(home.indexOf("Signed in as root"), home.indexOf('class="menu-sep"', home.indexOf("Boards")));
  const items = [...menu.matchAll(/href="([^"]+)"[^>]*>\s*<svg.*?<\/svg><span class="grow">([^<]+)<\/span/gs)].map((m) => ({ href: m[1]!, label: m[2]! }));
  expect(items.find((i) => i.label === "Repositories")?.href).toBe("/repos");
  expect(items.length).toBeGreaterThan(10);
  for (const item of items) {
    const want = MENU_TITLES[item.label];
    expect(want, `no expected title for the menu label "${item.label}"`).toBeDefined();
    const res = await get(item.href, rootCookie);
    expect(res.status, item.href).toBe(200);
    const title = (await res.text()).match(/<title>(.*?) · forge<\/title>/s)?.[1] ?? "";
    expect(title, item.href).toBe(want!);
  }
});

test("no word of the Now line lands on the boards or the releases", async () => {
  const home = await (await get("/", rootCookie)).text();
  const line = home.slice(home.indexOf('id="now-line"'));
  const links = [...line.slice(0, line.indexOf("</p>")).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  expect(links).toEqual(NOW_STAGES.map((s) => `/now/${s}`));
});

test("/repos lists the repositories you may write, and asks a visitor to sign in", async () => {
  const page = await (await get("/repos", aliceCookie)).text();
  expect(page).toContain("alice/notes");
  const out = await get("/repos", "");
  expect(out.status).toBe(303);
  expect(out.headers.get("location") ?? "").toContain("/sign");
});

async function screenText(user: User, make: (f: never, ctx: never) => unknown): Promise<string> {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  tui.start();
  tui.ctx.push(make(session as never, tui.ctx as never) as never);
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("the terminal has both doors: Now shows home's numbers to a site admin only, Repositories lists the same repositories", async () => {
  const rootUser = getUserByName(app.db, "root")!;
  const now = pipelineNow(app.db, Date.now() + 20_000);
  const text = await screenText(rootUser, (f, ctx) => nowScreen(f, ctx));
  expect(text).toContain(`${readNowRows(app.db, "check").total} · `);
  expect(text).toContain("[Check]");
  expect(now.check).toBeGreaterThan(0);
  expect(await screenText(alice, (f, ctx) => nowScreen(f, ctx))).toContain("Now is a site admin's.");
  expect(nowEntry.offered({ user: alice } as never)).toBe(false);
  expect(nowEntry.offered({ user: rootUser } as never)).toBe(true);
  expect(await screenText(alice, (f, ctx) => repoListScreen(f, ctx))).toContain("alice/notes");
  expect(reposEntry.offered({ user: undefined } as never)).toBe(false);
});

test("a queue longer than the cap lists the newest and says so, while the number stays the true count", async () => {
  const repo = app.db.query<{ id: string }, []>("SELECT id FROM repo LIMIT 1").get()!;
  for (let i = 0; i < NOW_LISTED + 5; i++)
    app.db.query("INSERT INTO run (id, repo_id, kind, state) VALUES (?, ?, 'check', 'queued')").run(crypto.randomUUID(), repo.id);
  const { total, rows } = readNowRows(app.db, "check");
  expect(total).toBeGreaterThan(NOW_LISTED);
  expect(rows.length).toBe(NOW_LISTED);
  const page = await (await get("/now/check", rootCookie)).text();
  expect(page).toContain(`<strong>${total}</strong>`);
  expect(page).toContain(`Showing the newest ${NOW_LISTED}.`);
});
