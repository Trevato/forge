/** Acting on a flow line where it stands (#9591): follow or stop, update a dependency; writer yes, reader and cross-origin no. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserById, type User } from "../src/core/users.ts";
import { askUpdate } from "../src/flows/file.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { readPins } from "../src/flows/pins.ts";
import { readRadar, refreshRadar } from "../src/flows/radar.ts";
import { readFlows } from "../src/flows/view.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";

let dir: string;
let app: App;
let servers: Servers;
const KEY = "flows-actions-key";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flows-actions-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const repoNow = () => getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
const admin = () => getUserById(app.db, app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(PREVIEW_ADMIN)!.id)!;
const stranger = () => ({ ...admin(), id: "nobody", isAdmin: false }) as User;
const headers = (id = "u1", name = "trevato", role = "admin") => {
  const said = `${id}|${name}|${role}|${Date.now() + 60_000}`;
  return { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
};
const issues = () => app.db.query<{ title: string }, [string]>("SELECT title FROM issue WHERE repo_id = ?1 AND title LIKE 'Update zed to %'").all(repoNow().id);

describe("follow or stop, on the line", () => {
  test("an admin's source and upstream lines carry one action; a reader's carry none", () => {
    const repo = repoNow();
    app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at) VALUES ('sa', ?1, 'https://example.com/a.git', 'main', 'u1', '2026-11-01T00:00:00Z')").run(repo.id);
    app.db.query("INSERT OR REPLACE INTO repo_upstream (repo_id, url, branch, enabled, by_id, updated_at) VALUES (?1, 'https://example.net/u.git', 'main', 1, 'u1', '2026-11-02T00:00:00Z')").run(repo.id);
    const mine = readFlows(app.db, repo, admin()).inbound;
    expect(mine.find((l) => l.kind === "source")?.action).toEqual({ label: "Stop following", href: `/${PREVIEW_ADMIN}/${PREVIEW_REPO}/settings/sources/sa/remove`, post: true, fields: { back: `/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows` } });
    const up = mine.find((l) => l.kind === "upstream")!.action!;
    expect([up.label, up.href, up.fields?.enabled]).toEqual(["Stop following", `/${PREVIEW_ADMIN}/${PREVIEW_REPO}/settings/upstream`, undefined]);
    for (const who of [undefined, stranger()]) {
      const lines = readFlows(app.db, repo, who).inbound;
      expect(lines.find((l) => l.kind === "source")?.action).toBeUndefined();
      expect(lines.find((l) => l.kind === "upstream")?.action).toBeUndefined();
    }
    app.db.query("UPDATE repo_upstream SET enabled = 0 WHERE repo_id = ?1").run(repo.id);
    const off = readFlows(app.db, repo, admin()).inbound.find((l) => l.kind === "upstream")!.action!;
    expect([off.label, off.fields?.enabled]).toEqual(["Follow again", "on"]);
  });

  test("the action posts through the existing route: admin stops it, cross-origin and anonymous do not", async () => {
    const url = `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/settings/sources/sa/remove`;
    const count = () => app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM repo_source WHERE id = 'sa'").get()!.n;
    const cross = await fetch(url, { method: "POST", redirect: "manual", headers: { ...headers(), origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    const anon = await fetch(url, { method: "POST", redirect: "manual", headers: { origin: servers.url } });
    expect([303, 200]).not.toContain(anon.status);
    expect(count()).toBe(1);
    const reader = await fetch(url, { method: "POST", redirect: "manual", headers: { ...headers("u7", "reader", "user"), origin: servers.url } });
    expect([303, 200]).not.toContain(reader.status);
    expect(count()).toBe(1);
    const ok = await fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ back: `/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows` }), headers: { ...headers(), origin: servers.url } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toContain(`/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`);
    expect(count()).toBe(0);
  });

  test("a back that leaves the site is ignored", async () => {
    const repo = repoNow();
    app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at) VALUES ('sb', ?1, 'https://example.com/b.git', 'main', 'u1', '2026-11-01T00:00:00Z')").run(repo.id);
    const res = await fetch(`${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/settings/sources/sb/remove`, { method: "POST", redirect: "manual", body: new URLSearchParams({ back: "//evil.example/x" }), headers: { ...headers(), origin: servers.url } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toContain("/settings");
    expect(res.headers.get("location")).not.toContain("evil");
  });

  test("the settings upstream route refuses a reader and keeps the follow", async () => {
    const url = `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/settings/upstream`;
    const was = app.db.query("SELECT enabled FROM repo_upstream").all();
    const reader = await fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ url: "https://example.net/u.git", branch: "main" }), headers: { ...headers("u7", "reader", "user"), origin: servers.url } });
    expect([303, 200]).not.toContain(reader.status);
    expect(app.db.query("SELECT enabled FROM repo_upstream").all()).toEqual(was);
  });
});

describe("update this dependency", () => {
  const lines = async () => {
    const repo = repoNow();
    const pins = readPins(JSON.stringify({ dependencies: { zed: "1.0.0" } }));
    await refreshRadar(app.db, repo.id, pins, async () => ({ latest: "1.2.0" }));
    return readRadar(app.db, repo.id, pins);
  };

  test("a reader, an agent and an unknown package file nothing", async () => {
    const l = await lines();
    const agent = { ...admin(), kind: "agent" } as User;
    for (const who of [undefined, stranger(), agent]) expect(askUpdate(app, repoNow(), who, l, "zed")).toEqual({ ok: false, why: "Only a writer of this repository can do this." });
    expect(askUpdate(app, repoNow(), admin(), l, "nope")).toEqual({ ok: false, why: "That package is not pinned here." });
    expect(issues()).toEqual([]);
  });

  test("a writer files one issue, and a second ask files none", async () => {
    const l = await lines();
    const first = askUpdate(app, repoNow(), admin(), l, "zed");
    expect(first.ok && first.filed).toBeGreaterThan(0);
    expect(issues()).toEqual([{ title: "Update zed to 1.2.0" }]);
    expect(askUpdate(app, repoNow(), admin(), l, "zed")).toEqual({ ok: true, filed: null });
    expect(issues().length).toBe(1);
  });

  test("the page shows Update this dependency to a writer, not to a reader; the route is same-origin only and refuses a stranger", async () => {
    const repo = repoNow();
    const pkg = JSON.stringify({ dependencies: { zed: "1.0.0" } });
    const made = await commitFiles(repoDir(app.reposRoot, PREVIEW_ADMIN, PREVIEW_REPO), { branch: repo.defaultBranch, message: "pins", files: [{ path: "package.json", content: pkg }], author: { name: "T", email: "t@forge.test" } });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    await refreshRadar(app.db, repo.id, readPins(pkg), async () => ({ latest: "1.2.0" }));
    app.db.query("DELETE FROM issue WHERE repo_id = ?1 AND title LIKE 'Update zed to %'").run(repo.id);
    const flows = `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;
    expect(await (await fetch(flows, { headers: headers() })).text()).toContain("Update this dependency");
    expect(await (await fetch(flows, { headers: headers("u7", "reader", "user") })).text()).not.toContain("Update this dependency");
    expect(await (await fetch(flows)).text()).not.toContain("Update this dependency");
    const url = `${flows}/update`;
    const body = () => new URLSearchParams({ name: "zed" });
    const cross = await fetch(url, { method: "POST", body: body(), redirect: "manual", headers: { ...headers(), origin: "https://evil.example" } });
    expect(cross.status).toBe(403);
    expect(issues()).toEqual([]);
    const reader = await fetch(url, { method: "POST", body: body(), redirect: "manual", headers: { ...headers("u7", "reader", "user"), origin: servers.url } });
    expect(reader.headers.get("location") ?? "").not.toContain("/issues/");
    const anon = await fetch(url, { method: "POST", body: body(), redirect: "manual", headers: { origin: servers.url } });
    expect(anon.headers.get("location") ?? "").not.toContain("/issues/");
    expect(issues()).toEqual([]);
    const ok = await fetch(url, { method: "POST", body: body(), redirect: "manual", headers: { ...headers(), origin: servers.url } });
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toContain("/issues/");
    expect(issues().length).toBe(1);
  });
});

describe("fork lines", () => {
  test("a fork's admin gets a link to its follow mode; a reader gets none", () => {
    const parent = repoNow();
    app.db.query("INSERT INTO repo (id, owner_id, name, visibility, fork_parent_id, default_branch, created_at) SELECT 'fk1', owner_id, 'forky', 'public', ?1, default_branch, created_at FROM repo WHERE id = ?1").run(parent.id);
    const line = readFlows(app.db, parent, admin()).outbound.find((l) => l.label.endsWith("/forky"))!;
    expect(line.action).toEqual({ label: "Follow mode", href: `/${PREVIEW_ADMIN}/forky/following`, post: false });
    expect(readFlows(app.db, parent, undefined).outbound.find((l) => l.label.endsWith("/forky"))?.action).toBeUndefined();
  });
});
