import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { removeAccount, retireAndRemoveAccount } from "../src/actions/accounts.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { proveAll } from "./helpers/verified.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";

describe("removing an account: what stops it", () => {
  let dataDir: string;
  let app: App;
  let admin: User;
  let nosy: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-remove-refusals-"));
    app = createApp({ dataDir, port: 0, url: "https://forge.example", edgeToken: "e" });
    const made = await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: "a-long-passphrase" });
    if (!made.ok) throw new Error(made.error);
    admin = made.value;
    nosy = await mk("nosy");
  });
  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mk = async (username: string): Promise<User> => {
    const u = await signUp(app, {
      username,
      email: `${username}@f.dev`,
      password: "a-long-passphrase",
    }, { slot: fixtureSlot(app) });
    if (!u.ok) throw new Error(u.error);
    proveAll(app);
    return getUserByName(app.db, username)!;
  };
  const withRepo = async (name: string): Promise<User> => {
    const u = await mk(name);
    promote(app.db, u);
    const r = await createRepo(app, u, { name: "ledger" });
    if (!r.ok) throw new Error(r.error);
    return u;
  };

  test("without confirmed: true the answer is confirm_required and nothing changes", async () => {
    const u = await withRepo("kept");
    for (const options of [undefined, {}, { confirmed: false }]) {
      const out = await retireAndRemoveAccount(app, admin, "kept", options);
      expect(out).toEqual({ ok: false, error: "confirm_required" });
    }
    expect(getUserByName(app.db, "kept")!.removedAt).toBeNull();
    expect(listReposOwnedBy(app.db, u.id).length).toBe(1);
    expect(existsSync(repoDir(app.reposRoot, "kept", "ledger"))).toBe(true);
  });

  test("with confirmed: true the account and its repositories go", async () => {
    const u = await withRepo("gone");
    const out = await retireAndRemoveAccount(app, admin, "gone", { confirmed: true });
    expect(out.ok && out.value).toEqual({ removed: ["gone/ledger", "gone"], failed: null });
    expect(getUserByName(app.db, "gone")!.removedAt).not.toBeNull();
    expect(listReposOwnedBy(app.db, u.id).length).toBe(0);
    expect(existsSync(repoDir(app.reposRoot, "gone", "ledger"))).toBe(false);
  });

  // chmod does not stop root, so there is nothing to make unremovable.
  test.skipIf(process.getuid?.() === 0)("a repository that cannot be removed stops the delete and the account row stays", async () => {
    const u = await withRepo("stuck");
    const dir = repoDir(app.reposRoot, "stuck", "ledger");
    const parent = dirname(dir);
    chmodSync(parent, 0o555);
    try {
      const out = await removeAccount(app, admin, "stuck");
      expect(out).toEqual({ ok: false, error: "delete_failed" });
      expect(getUserByName(app.db, "stuck")!.removedAt).toBeNull();
      expect(existsSync(dir)).toBe(true);
      expect(listReposOwnedBy(app.db, u.id).length).toBe(1);
    } finally {
      chmodSync(parent, 0o755);
    }
    // Nothing was orphaned: with the directory removable again, a retry
    // finishes the job.
    expect((await removeAccount(app, admin, "stuck")).ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(getUserByName(app.db, "stuck")!.removedAt).not.toBeNull();
  });

  test("a non-admin and a signed-out caller are refused before anything else", async () => {
    await withRepo("safe");
    for (const actor of [nosy, undefined]) {
      expect(await retireAndRemoveAccount(app, actor, "safe")).toEqual({ ok: false, error: "not_found" });
      expect(await retireAndRemoveAccount(app, actor, "safe", { confirmed: true })).toEqual({ ok: false, error: "not_found" });
      expect(await removeAccount(app, actor, "safe")).toEqual({ ok: false, error: "not_found" });
    }
    expect(getUserByName(app.db, "safe")!.removedAt).toBeNull();
    expect(existsSync(repoDir(app.reposRoot, "safe", "ledger"))).toBe(true);
  });
});
