/**
 * Archiving from the home: an admin ticks apps and archives them in one
 * step; the answer lists them and offers the fleet's undo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feedCss } from "../src/web/studio/feed_style.ts";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("home archive", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let root: User;
  let rootCookie: string;
  let bobCookie: string;
  let repos: Repo[];

  const get = (path: string, cookie: string) =>
    fetch(`${servers.url}${path}`, {
      headers: { cookie: `${cookie}; forge_mode=studio` },
      redirect: "manual",
    });
  const post = (path: string, cookie: string, body: string, origin = servers.url) =>
    fetch(`${servers.url}${path}`, {
      method: "POST",
      headers: {
        cookie: `${cookie}; forge_mode=studio`,
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-home-archive-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const r = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!r.ok) throw new Error(r.error);
      promote(app.db, r.value);
      return r.value;
    };
    root = await mk("keeper", true);
    const bob = await mk("bob");
    rootCookie = `forge_session=${createSession(app.db, root.id).token}`;
    bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
    repos = [];
    for (const name of ["alpha", "beta", "gamma"]) {
      const made = await createRepo(app, root, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      insertApp(app.db, { repoId: made.value.id, slug: name, access: "public" });
      repos.push(made.value);
    }
    const mine = await createRepo(app, bob, { name: "mine", visibility: "public" });
    if (!mine.ok) throw new Error(String(mine.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const body = (...ids: string[]) => ids.map((id) => `repo=${id}`).join("&");
  const home = async (cookie: string) => (await get("/live/apps", cookie)).text();
  const full = async (cookie: string) => (await get("/feed", cookie)).text();

  test("an admin archives two, the answer lists them, Undo brings them back", async () => {
    const before = await full(rootCookie);
    expect(before).toContain('name="repo"');
    expect(before).toContain("keeper/alpha");

    const res = await post("/home/archive", rootCookie, body(repos[0]!.id, repos[1]!.id));
    expect(res.status).toBe(303);
    const receipt = res.headers.get("location")!;
    expect(receipt).toStartWith("/home/archived/");

    const after = await home(rootCookie);
    expect(after).not.toContain("keeper/alpha");
    expect(after).not.toContain("keeper/beta");
    expect(after).toContain("keeper/gamma");

    const answer = await (await get(receipt, rootCookie)).text();
    expect(answer).toContain("keeper/alpha");
    expect(answer).toContain("keeper/beta");
    expect(answer.replace(/\s+/g, " ")).toContain("2 apps archived");
    expect(answer).toContain(`action="${receipt}/undo"`);

    const undone = await post(`${receipt}/undo`, rootCookie, "");
    expect(undone.status).toBe(303);
    const back = await home(rootCookie);
    expect(back).toContain("keeper/alpha");
    expect(back).toContain("keeper/beta");

    const twice = await post(`${receipt}/undo`, rootCookie, "");
    expect(twice.status).toBe(303);
    expect(twice.headers.get("location")).toBe("/");
  });

  test("the rail ends with `N archived` once something is put away, and it leads there", async () => {
    expect(await full(rootCookie)).not.toMatch(/\d+ archived<\/a>/);
    const res = await post("/home/archive", rootCookie, body(repos[2]!.id));
    const receipt = res.headers.get("location")!;
    const page = await full(rootCookie);
    expect(page).toContain('<a href="/apps?archived=1">1 archived</a>');
    const listed = await (await get("/apps?archived=1", rootCookie)).text();
    expect(listed).toContain("keeper/gamma");
    expect(await full(bobCookie)).toContain("1 archived</a>"); // public, so bob can see it too
    await post(`${receipt}/undo`, rootCookie, "");
    expect(await full(rootCookie)).not.toMatch(/\d+ archived<\/a>/);
  });

  test("a cross-origin post is refused and archives nothing", async () => {
    const res = await post(
      "/home/archive",
      rootCookie,
      body(repos[2]!.id),
      "https://evil.example",
    );
    expect(res.status).toBe(403);
    expect(await home(rootCookie)).toContain("keeper/gamma");
  });

  test("the apps rail is drawn with the design system's classes alone", async () => {
    const page = await full(rootCookie);
    for (const old of ["home-rail", "home-apps", "home-app", "home-apps-verbs", "home-pick"])
      expect(page).not.toMatch(new RegExp(`class="[^"]*\\b${old}\\b`));
    expect(page).toContain("Your apps");
    expect(page).toContain('href="/apps/new"');
    expect(page).toContain('href="/map"');
    expect(page).toContain("keeper/gamma");
    expect(page).toMatch(/<form method="post" action="\/home\/archive">[\s\S]*name="repo"[\s\S]*Archive/);
    expect(page).toContain('class="truncate break"');
  });

  test("the stylesheet no longer names the removed classes", () => {
    for (const old of ["home-rail", "home-apps", "home-app", "home-pick", "apps-select"])
      expect(feedCss).not.toContain(old);
    expect(feedCss).toContain("#live-apps");
  });

  test("a non-admin sees no checkboxes and cannot post", async () => {
    const page = await full(bobCookie);
    expect(page).not.toContain('name="repo"');
    expect(page).not.toContain("apps-select");
    const res = await post("/home/archive", bobCookie, body(repos[2]!.id));
    expect(res.status).toBe(403);
    expect(await home(rootCookie)).toContain("keeper/gamma");
  });

  test("another admin reads the receipt but is not offered Undo", async () => {
    app.db.run("UPDATE user SET is_admin = 1 WHERE username = 'bob'");
    const res = await post("/home/archive", rootCookie, body(repos[2]!.id));
    const receipt = res.headers.get("location")!;
    const mine = await (await get(receipt, rootCookie)).text();
    const theirs = await (await get(receipt, bobCookie)).text();
    expect(mine).toContain("/undo");
    expect(theirs).toContain("keeper/gamma");
    expect(theirs).not.toContain("/undo");
    app.db.run("UPDATE user SET is_admin = 0 WHERE username = 'bob'");
  });
});
