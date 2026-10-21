import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAccount } from "../src/actions/accounts.ts";
import { createRepo, deleteRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App } from "../src/app.ts";
import { getUserByName } from "../src/core/users.ts";
import { claudeSettings } from "../src/crew/claude.ts";
import { installCacheEnv, sandboxPolicy } from "../src/crew/sandbox.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { proveAll } from "./helpers/verified.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { installCacheDir, removeInstallCache } from "../src/crew/workdir.ts";

const policy = (dataDir: string, repoId: string) =>
  sandboxPolicy({
    dataDir,
    agentName: "scout",
    urls: [],
    runId: "run0000000000001",
    repoId,
  });

describe("the shared install cache", () => {
  const data = mkdtempSync(join(tmpdir(), "fc-cache-"));

  test("a run's policy names its repository's cache and lets the shell write there", () => {
    const p = policy(data, "r1");
    expect(p.installCache).toBe(installCacheDir(data, "r1"));
    expect(p.installCache).toBe(join(data, "crew", ".cache", "r1", "bun"));
    const fs = (claudeSettings(p)["sandbox"] as any).filesystem;
    expect(fs.allowWrite).toEqual([p.installCache]);
    // The cache root is denied whole, this repository's own re-allowed.
    expect(p.denyRead).toContain(join(data, "crew", ".cache"));
    expect(p.readAllow).toEqual([join(data, "crew", ".cache", "r1", "bun")]);
    expect(fs.allowRead).toEqual(p.readAllow);
  });

  test("a run with no repository has no cache and no extra write", () => {
    const p = sandboxPolicy({ dataDir: data, agentName: "scout", urls: [] });
    expect(p.installCache).toBeUndefined();
    const fs = (claudeSettings(p)["sandbox"] as any).filesystem;
    expect(fs.allowWrite).toBeUndefined();
  });

  test("two repositories get two caches, and each run may read only its own", () => {
    expect(installCacheDir(data, "r1")).not.toBe(installCacheDir(data, "r2"));
    const one = policy(data, "r1");
    const two = policy(data, "r2");
    expect(one.readAllow).toEqual([join(data, "crew", ".cache", "r1", "bun")]);
    expect(two.readAllow).toEqual([join(data, "crew", ".cache", "r2", "bun")]);
    // Denied whole, so a cache made after the policy was built is denied too.
    expect(one.denyRead).toContain(join(data, "crew", ".cache"));
    expect(two.denyRead).toContain(join(data, "crew", ".cache"));
  });

  test("the run's env names the cache and the directory is made", () => {
    const env: Record<string, string> = {};
    installCacheEnv(policy(data, "r1"), env);
    expect(env["BUN_INSTALL_CACHE_DIR"]).toBe(installCacheDir(data, "r1"));
    expect(existsSync(installCacheDir(data, "r1"))).toBe(true);
    const other: Record<string, string> = {};
    installCacheEnv(policy(data, "r2"), other);
    expect(other["BUN_INSTALL_CACHE_DIR"]).not.toBe(env["BUN_INSTALL_CACHE_DIR"]);
    const none: Record<string, string> = {};
    installCacheEnv(sandboxPolicy({ dataDir: data, agentName: "scout", urls: [] }), none);
    expect(none).toEqual({});
  });

  test("bun's temp directory is the one the sandboxed shell can write", () => {
    const p = policy(data, "r1");
    const env: Record<string, string> = {};
    installCacheEnv(p, env);
    const writable = join(p.tmpDir!, `claude-${process.getuid?.() ?? 0}`);
    // The run's temp directory itself is read-only in the shell; only the
    // claude-<uid> directory under it is bound writable.
    expect(env["BUN_TMPDIR"]).toBe(writable);
    expect(env["BUN_TMPDIR"]).not.toBe(p.tmpDir!);
    expect(existsSync(writable)).toBe(true);
    expect(p.denyRead).not.toContain(p.tmpDir!);
  });

  test("removing a repository clears its cache and only its", async () => {
    await removeInstallCache(data, "r1");
    expect(existsSync(installCacheDir(data, "r1"))).toBe(false);
    expect(existsSync(installCacheDir(data, "r2"))).toBe(true);
  });
});

describe("a deleted repository's cache", () => {
  let dataDir: string;
  let app: App;
  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "fc-cache-del-"));
    app = createApp({ dataDir, port: 0 });
    const admin = await seedAdmin(app, { username: "ada", email: "ada@f.dev", password: "owner-passphrase" });
    if (!admin.ok) throw new Error("seed");
    const bob = await signUp(app, { username: "bob", email: "bob@f.dev", password: "bob-passphrase" }, { slot: fixtureSlot(app) });
    if (!bob.ok) throw new Error("signup");
    proveAll(app);
    promote(app.db);
  });
  afterAll(() => {
    app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const warm = (id: string) => {
    mkdirSync(installCacheDir(dataDir, id), { recursive: true });
    writeFileSync(join(installCacheDir(dataDir, id), "pkg"), "x");
  };

  test("deleting the repository clears its cache and not another's", async () => {
    const bob = getUserByName(app.db, "bob")!;
    const a = await createRepo(app, bob, { name: "a", visibility: "private" });
    const b = await createRepo(app, bob, { name: "b", visibility: "private" });
    if (!a.ok || !b.ok) throw new Error("repo");
    warm(a.value.id);
    warm(b.value.id);
    expect((await deleteRepo(app, bob, a.value)).ok).toBe(true);
    expect(existsSync(installCacheDir(dataDir, a.value.id))).toBe(false);
    expect(existsSync(installCacheDir(dataDir, b.value.id))).toBe(true);
  });

  test("removing an account clears the caches of its repositories", async () => {
    const admin = getUserByName(app.db, "ada")!;
    const bob = getUserByName(app.db, "bob")!;
    const c = await createRepo(app, bob, { name: "c", visibility: "private" });
    if (!c.ok) throw new Error("repo");
    warm(c.value.id);
    const done = await removeAccount(app, admin, "bob");
    expect(done.ok).toBe(true);
    expect(existsSync(installCacheDir(dataDir, c.value.id))).toBe(false);
  });
});
