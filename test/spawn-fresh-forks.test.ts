/**
 * A client's forge in one form (#1608): two forked apps and one fresh from a
 * sentence, and one claim link.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { commitFiles } from "../src/git/write.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { freshName, planSpawn } from "../src/spawn/plan.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-fresh-forks-passphrase";

describe("a forge with forked and fresh apps", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let cookie = "";

  const post = (form: [string, string][]) =>
    fetch(`${servers.url}/forges/new`, {
      method: "POST",
      headers: { cookie, origin: "https://forge.test" },
      body: new URLSearchParams(form),
      redirect: "manual",
    });
  const base: [string, string][] = [
    ["name", "kai"],
    ["apps", "alice/bakery"],
    ["apps", "alice/shop"],
  ];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-fresh-forks-"));
    app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@x.test",
      password: PASSWORD,
      isAdmin: true,
    });
    if (!a.ok) throw new Error("user");
    for (const name of ["bakery", "shop"]) {
      const r = await createRepo(app, a.value, { name });
      if (!r.ok) throw new Error("repo");
      const c = await commitFiles(repoDir(app.reposRoot, "alice", name), {
        branch: "main",
        message: name,
        files: [{ path: "README.md", content: `# ${name}\n` }],
        author: { name: "a", email: "a@x.invalid" },
      });
      if (!c.ok) throw new Error("commit");
    }
    servers = await serve(app);
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: PASSWORD }),
      redirect: "manual",
    });
    cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the plan names the fresh app and the real address, and makes nothing", async () => {
    const res = await post([
      ...base,
      ["fresh", "A booking page for Kai's shop"],
      ["do", "plan"],
    ]);
    const html = (await res.text()).replace(/\s+/g, " ");
    expect(html).toContain("a fresh app a-booking-page-for-kai-s-shop");
    expect(html).toContain("https://kai--forge.test");
    expect(await readdir(join(dir, "spawn")).catch(() => [])).toEqual([]);
  });

  test("a multi-line sentence is refused beside its field", async () => {
    const f = await post([...base, ["fresh", "one\ntwo"], ["do", "plan"]]);
    expect(f.status).toBe(422);
    expect(await f.text()).toContain("must be one line");
  });

  test("spawn makes two forks and a fresh app and answers one claim link", async () => {
    const res = await post([
      ...base,
      ["fresh", "A *booking* page <b>[x](y)"],
      ["do", "spawn"],
    ]);
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.text()).match(/\/claim#/g)?.length).toBe(1);

    const ledger = await Bun.file(join(dir, "spawn", "kai.json")).json();
    const child = childDirOf(app, ledger.bodyId);
    const meta = await Bun.file(join(child, "parent.json")).json();
    // Each app records where it came from and that it follows it, taking updates (`spawn/app_links.ts`).
    expect(meta.apps).toMatchObject([
      { repo: "kai/bakery", upstream: "alice/bakery", url: "https://forge.test/alice/bakery.git", branch: "main", mode: "take-updates" },
      { repo: "kai/shop", upstream: "alice/shop", url: "https://forge.test/alice/shop.git", branch: "main", mode: "take-updates" },
    ]);
    expect(meta.apps.every((a: { appliedAt?: string; token?: string }) => a.appliedAt !== undefined && a.token === undefined)).toBe(true);
    expect(meta.fresh).toBe("kai/a-booking-page-b-x-y");
    expect("domain" in meta).toBe(false);

    const repos = await readdir(join(child, "repos", "kai")).catch(() => [] as string[]);
    expect(repos.some((r) => r.startsWith("a-booking-page-b-x-y"))).toBe(true);
    const index = Bun.spawnSync(
      ["git", "show", "main:index.ts"],
      { cwd: repoDir(join(child, "repos"), "kai", "a-booking-page-b-x-y") },
    );
    expect(index.stdout.toString()).toContain("A *booking* page");
    const readme = Bun.spawnSync(["git", "show", "main:README.md"], {
      cwd: repoDir(join(child, "repos"), "kai", "a-booking-page-b-x-y"),
    }).stdout.toString();
    // No live markdown or HTML from the sentence: every mark is escaped.
    expect(readme).toContain("A \\*booking\\* page \\<b\\>\\[x\\]\\(y\\)");
    const forkLog = Bun.spawnSync(["git", "log", "--oneline", "main"], {
      cwd: repoDir(join(child, "repos"), "kai", "bakery"),
    });
    expect(forkLog.stdout.toString()).toContain("bakery");
  });

  test("a fresh name avoids a forked app's name; none given changes nothing", () => {
    expect(freshName("Bakery", new Set(["bakery"]))).toBe("bakery-2");
    expect(freshName("!!!", new Set())).toBe("app");
    const plan = planSpawn(
      { name: "x", org: "x", apps: [], carryBriefs: false, carrySubscriptions: false },
      { catalog: [], briefs: [], subscriptions: [] },
    );
    expect(plan.ok && "fresh" in plan.value).toBe(false);
  });

  test("a fresh app never takes the name `forge`, which the forge-code fork owns", () => {
    for (const sentence of ["Forge", "forge!"]) {
      const plan = planSpawn(
        { name: "x", org: "x", apps: [], carryBriefs: false, carrySubscriptions: false, fresh: sentence },
        { catalog: [], briefs: [], subscriptions: [] },
      );
      expect(plan.ok && plan.value.fresh?.name).toBe("forge-2");
    }
  });
});
