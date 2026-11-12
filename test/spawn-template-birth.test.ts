/**
 * A forge made from a template begins with its files (#7535): `starter`
 * commits the scaffold into one private repo, `blank` adds nothing, a retry
 * adds nothing more, and nothing of the parent travels.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { childDirOf, spawnForge, type SpawnDeps } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { bakedFiles as scaffoldFiles } from "../src/apps/template.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { hostedPlacement } from "../src/spawn/placement.ts";
import type { SpawnSource } from "../src/spawn/plan.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SENTENCE = "A booking page";
const source: SpawnSource = { catalog: [], briefs: [], subscriptions: [] };

describe("a forge made from a template", () => {
  let dir = "";
  let parent: App;
  let alice: User;
  let secret = "";
  const deps: SpawnDeps = {
    placement: hostedPlacement({ host: "forge.test" }),
    request: new Request("https://forge.test/x", { method: "POST", headers: { origin: "https://forge.test" } }),
    url: new URL("https://forge.test/x"),
  };
  const spawn = async (name: string, extra: Record<string, unknown>) => {
    const r = await spawnForge(
      parent,
      alice,
      { name, org: name, apps: [], carryBriefs: false, carrySubscriptions: false, ...extra },
      source,
      deps,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return childDirOf(parent, r.value.bodyId);
  };
  const git = (childDir: string, org: string, repo: string, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(join(childDir, "repos"), org, repo) }).stdout.toString();
  const repos = (childDir: string, org: string) => readdir(join(childDir, "repos", org)).catch(() => [] as string[]);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-template-birth-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const made = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.invalid", isAdmin: true });
    if (!made.ok) throw new Error("user");
    alice = made.value;
    const repo = await createRepo(parent, alice, { name: "secrets-here" });
    if (!repo.ok) throw new Error("repo");
    await commitFiles(repoDir(parent.reposRoot, "alice", "secrets-here"), {
      branch: "main",
      message: "x",
      files: [{ path: "README.md", content: "# x\n" }],
      author: { name: "a", email: "a@x.invalid" },
    });
    const t = createToken(parent.db, alice.id, "ci", "rw");
    secret = t.token;
  }, 30_000);

  afterAll(async () => {
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a forge made with starter has the starter's files", async () => {
    const c = await spawn("kai", { template: "starter", fresh: SENTENCE });
    expect(await repos(c, "kai")).toContain("a-booking-page.git");
    expect(await repos(c, "kai").then((r) => r.filter((n) => n !== "forge" && n !== "forge.git"))).toHaveLength(1);
    const want = scaffoldFiles({ name: "a-booking-page", description: SENTENCE }).map((f) => f.path).sort();
    const got = git(c, "kai", "a-booking-page", "ls-tree", "-r", "--name-only", "main").trim().split("\n").sort();
    expect(got).toEqual(want);
    expect(git(c, "kai", "a-booking-page", "show", "main:README.md")).toContain(SENTENCE);
    const child = createApp({ dataDir: c, port: 0 });
    expect(getRepo(child.db, "kai", "a-booking-page")?.visibility).toBe("private");
    child.close();
  }, 60_000);

  test("without a sentence the app is named app", async () => {
    const c = await spawn("noa", { template: "starter" });
    const want = scaffoldFiles({ name: "app", description: "" }).map((f) => f.path).sort();
    expect(git(c, "noa", "app", "ls-tree", "-r", "--name-only", "main").trim().split("\n").sort()).toEqual(want);
  }, 60_000);

  test("a forge made with blank is unchanged", async () => {
    const none = await spawn("blankone", {});
    const blank = await spawn("blanktwo", { template: "blank" });
    const left = (await repos(none, "blankone")).sort();
    expect((await repos(blank, "blanktwo")).sort()).toEqual(left);
    expect(left).not.toContain("app");
    expect(left).not.toContain("app.git");
  }, 60_000);

  test("a retry makes no second template repo", async () => {
    const input = { template: "starter", fresh: SENTENCE };
    const c = await spawn("rae", input);
    const before = await repos(c, "rae");
    const commits = git(c, "rae", "a-booking-page", "rev-list", "--count", "main").trim();
    const again = await spawn("rae", input);
    expect(again).toBe(c);
    expect(await repos(again, "rae")).toEqual(before);
    expect(git(c, "rae", "a-booking-page", "rev-list", "--count", "main").trim()).toBe(commits);
    expect(commits).toBe("1");
  }, 60_000);

  test("parent.json records the template", async () => {
    const c = await spawn("pat", { template: "starter" });
    const meta = await Bun.file(join(c, "parent.json")).json();
    expect(meta.template).toEqual({ id: "starter" });
    const b = await spawn("pib", {});
    expect("template" in (await Bun.file(join(b, "parent.json")).json())).toBe(false);
  }, 60_000);

  test("the template repo holds no parent secrets", async () => {
    const c = await spawn("sam", { template: "starter" });
    const all = git(c, "sam", "app", "grep", "-I", "-e", "", "main").toString();
    expect(all).not.toContain("secrets-here");
    expect(all).not.toContain(secret);
    expect(git(c, "sam", "app", "log", "--format=%an <%ae>", "main").trim()).toBe("forge <forge@spawn.forge.invalid>");
  }, 60_000);

  test("first boot enables the template app", async () => {
    const c = await spawn("fay", { template: "starter", direction: "Run it" });
    const child = createApp({ dataDir: c, port: 0 });
    await firstBoot(child);
    const repo = getRepo(child.db, "fay", "app")!;
    expect(getAppByRepo(child.db, repo.id)).toBeDefined();
    child.close();
  }, 60_000);
});
