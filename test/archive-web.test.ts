/**
 * An archived repository leaves the web home's apps, the explorer's default
 * view and the inbox (assigned work included); `archived:yes` and its own
 * page still show it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { explore, parseExploreQuery } from "../src/actions/explore.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { setAssignee } from "../src/core/issues.ts";
import {
  listReposVisibleTo,
  listReposWritableTo,
  updateRepoSettings,
  type Repo,
} from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("an archived repository on the web", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;
  let cookie = "";
  let assigned = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-archive-web-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-long-archive-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-long-archive-passphrase" }),
      redirect: "manual",
    });
    cookie = `${(res.headers.get("set-cookie") ?? "").split(";")[0]!}; forge_mode=studio`;
    const r = await createRepo(app, alice, { name: "oldie", visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    repo = r.value;
    const rec = insertApp(app.db, { repoId: repo.id, slug: "oldie", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    const issue = openIssue(app, alice, repo, { title: "Sweep the shed", body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    assigned = issue.value.id;
    setAssignee(app.db, assigned, alice.id);
  }, 30_000);

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const get = async (path: string) =>
    (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();
  const names = async (line: string) =>
    (await explore(app, alice, parseExploreQuery(line))).map((r) => r.name);

  test("present while live: home, explorer, inbox", async () => {
    expect(await get("/live/on-you")).toContain("Sweep the shed");
    expect(await get("/live/apps")).toContain("alice/oldie");
    expect(await names("kind:app")).toContain("alice/oldie");
    expect(askLinesFor(app.db, alice).some((l) => l.id === `assigned:${assigned}`)).toBe(true);
  });

  test("absent once archived, the assigned issue included", async () => {
    repo = updateRepoSettings(app.db, repo, { archived: true });
    expect(await get("/live/apps")).not.toContain("alice/oldie");
    expect(await get("/live/on-you")).not.toContain("Sweep the shed");
    expect(askLinesFor(app.db, alice).some((l) => l.id === `assigned:${assigned}`)).toBe(false);
    expect(await names("kind:app")).not.toContain("alice/oldie");
    expect(listReposWritableTo(app.db, alice, { withoutArchived: true })).toHaveLength(0);
    expect(listReposVisibleTo(app.db, alice, { withoutArchived: true })).toHaveLength(0);
    // Off by default: the repository API's list still has it.
    expect(listReposVisibleTo(app.db, alice)).toHaveLength(1);
  });

  test("archived:yes brings it back, the toggle says its state, its page answers 200", async () => {
    expect(await names("kind:app archived:yes")).toContain("alice/oldie");
    const off = await get("/explore");
    expect(off).toContain("Show archived");
    expect(off).toContain('aria-pressed="false"');
    const on = await get(`/explore?q=${encodeURIComponent("archived:yes")}`);
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("alice/oldie");
    expect((await fetch(`${servers.url}/alice/oldie`, { headers: { cookie } })).status).toBe(200);
  });
});
