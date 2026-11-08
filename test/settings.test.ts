import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { setMirrorTarget } from "../src/core/migrate_mirror.ts";
import { recordProvenance } from "../src/core/provenance.ts";
import { listLabels } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";

describe("repo settings", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let ownerCookie = "";
  let strangerCookie = "";

  const form = (fields: Record<string, string>) => new URLSearchParams(fields);

  async function signup(username: string): Promise<string> {
    const res = await fetch(`${base}/signup`, {
      method: "POST",
      body: form({
        username,
        email: `${username}@f.dev`,
        password: "settings-password",
      }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-settings-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    ownerCookie = await adminCookie(app, { username: "olive", email: "olive@f.dev", password: "settings-password" });
    strangerCookie = await signup("stranger");
    await fetch(`${base}/new`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({ name: "proj", visibility: "private", description: "start" }),
      redirect: "manual",
    });
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the General page has no card and each form posts where it did", async () => {
    const repo = getRepo(app.db, "olive", "proj")!;
    app.db.run("PRAGMA foreign_keys = OFF");
    setMirrorTarget(app.db, {
      repoId: repo.id,
      originId: "origin-1",
      fullName: "olive/proj-mirror",
      cloneUrl: "https://example.test/olive/proj-mirror.git",
      tips: {},
    });
    recordProvenance(app.db, repo.id, { url: "https://github.com/olive/proj", parents: [] });
    const res = await fetch(`${base}/olive/proj/settings`, { headers: { cookie: ownerCookie } });
    const page = await res.text();
    expect(res.status).toBe(200);
    expect(page).not.toContain('class="card');
    const posts = (path: string) => `method="post" action="/olive/proj${path}"`;
    for (const path of [
      "/settings",
      "/settings/wave",
      "/settings/archive",
      "/settings/provenance",
    ])
      expect(page).toContain(posts(path));
    // Stopping the mirror asks first: the page links to the confirm, which posts.
    expect(page).toContain(`/-/confirm?to=${encodeURIComponent("/olive/proj/settings/mirror/stop")}`);
    for (const h of [
      "About",
      "Branch and gates",
      "Cut a wave",
      "Archive",
      "Mirror",
      "Show where this came from",
      "Follow upstream",
      "Followed sources",
    ])
      expect(page).toMatch(new RegExp(`<section class="settings-block"[^>]*>\\s*<h2>${h}</h2>`));
  });

  test("only the owner can reach settings", async () => {
    expect(
      (
        await fetch(`${base}/olive/proj/settings`, {
          headers: { cookie: ownerCookie },
        })
      ).status,
    ).toBe(200);
    // A stranger can't even see the private repo exists.
    expect(
      (
        await fetch(`${base}/olive/proj/settings`, {
          headers: { cookie: strangerCookie },
        })
      ).status,
    ).toBe(404);
    expect((await fetch(`${base}/olive/proj/settings`)).status).toBe(404);
  });

  test("owner updates visibility, description, and protection", async () => {
    const res = await fetch(`${base}/olive/proj/settings`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({
        visibility: "public",
        description: "now public",
        protect: "on",
      }),
      redirect: "manual",
    });
    expect(res.status).toBe(303);
    const repo = getRepo(app.db, "olive", "proj")!;
    expect(repo.visibility).toBe("public");
    expect(repo.description).toBe("now public");
    expect(repo.protectDefault).toBe(true);
  });

  test("a stranger cannot change settings", async () => {
    const res = await fetch(`${base}/olive/proj/settings`, {
      method: "POST",
      headers: { cookie: strangerCookie },
      body: form({ visibility: "private", description: "hijacked" }),
      redirect: "manual",
    });
    expect(res.status).toBe(404);
    expect(getRepo(app.db, "olive", "proj")!.description).toBe("now public");
  });

  test("create and delete labels", async () => {
    await fetch(`${base}/olive/proj/settings/labels`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({ name: "bug", color: "d73a4a" }),
      redirect: "manual",
    });
    let labels = listLabels(app.db, getRepo(app.db, "olive", "proj")!.id);
    expect(labels.map((l) => l.name)).toContain("bug");
    const labelId = labels.find((l) => l.name === "bug")!.id;

    // The label shows on the Labels pane with its color bound via nonce'd CSS.
    const pageHtml = await (
      await fetch(`${base}/olive/proj/settings/labels`, {
        headers: { cookie: ownerCookie },
      })
    ).text();
    expect(pageHtml).toContain("lc-d73a4a");
    expect(pageHtml).toContain(".lc-d73a4a{--label:#d73a4a}");
    // The colour readout beside the picker draws from base utilities, not .hex.
    expect(pageHtml).toContain('<span class="mono muted" data-hex>#');
    expect(pageHtml).not.toContain('class="hex"');

    await fetch(`${base}/olive/proj/settings/labels/${labelId}/delete`, {
      method: "POST",
      headers: { cookie: ownerCookie },
      body: form({}),
      redirect: "manual",
    });
    labels = listLabels(app.db, getRepo(app.db, "olive", "proj")!.id);
    expect(labels.map((l) => l.name)).not.toContain("bug");
  });

  test("cross-origin settings update is refused", async () => {
    const res = await fetch(`${base}/olive/proj/settings`, {
      method: "POST",
      headers: { cookie: ownerCookie, origin: "http://evil.example" },
      body: form({ visibility: "private" }),
      redirect: "manual",
    });
    expect(res.status).toBe(403);
  });
});
