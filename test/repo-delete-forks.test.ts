import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, deleteRepo, forkRepo, getRepo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { commitFiles } from "../src/git/write.ts";
import { signUpProven as signUp } from "./helpers/verified.ts";
import type { Repo } from "../src/core/repos.ts";

/**
 * Deleting a repository with forks: each fork is detached first, so every
 * fork still clones afterwards; a fork that cannot be detached stops the
 * delete with `delete_failed` and leaves the parent whole.
 */

const git = async (cwd: string, ...args: string[]) => {
  const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return { out: out.trim(), code };
};

/** As root, a read-only directory does not stop a write: the failures cannot be made. */
const unprivileged = process.getuid?.() !== 0;

describe("deleting a repository with forks", () => {
  let dataDir: string;
  let app: App;
  let n = 0;
  const subjects = ["one", "two", "three"];

  const user = async (username: string) => {
    const u = await signUp(app, {
      username,
      email: `${username}@forge.test`,
      password: "a-long-passphrase",
    });
    if (!u.ok) throw new Error("signup failed");
    return u.value;
  };

  /** A public parent of three commits, owned by `owner`, with two forks. */
  const family = async () => {
    n += 1;
    const owner = await user(`owner${n}`);
    const a = await user(`forka${n}`);
    const b = await user(`forkb${n}`);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "parent",
      visibility: "public",
    });
    if (!made.ok) throw new Error("create failed");
    const parent = made.value;
    const dir = repoDir(app.reposRoot, parent.ownerName, parent.name);
    for (const subject of subjects) {
      const c = await commitFiles(dir, {
        branch: "main",
        message: subject,
        files: [{ path: `${subject}.txt`, content: subject }],
        author: { name: "T", email: "t@forge.test" },
      });
      if (!c.ok) throw new Error("commit failed");
    }
    const forks: Repo[] = [];
    for (const f of [a, b]) {
      const r = await forkRepo(app.db, app.reposRoot, parent, f.id);
      if (!r.ok) throw new Error(`fork failed: ${r.error}`);
      forks.push(r.value);
    }
    const fork = (f: Repo) => repoDir(app.reposRoot, f.ownerName, f.name);
    return { parent, dir, forks, fork };
  };

  const cloneSubjects = async (from: string): Promise<string[]> => {
    const into = await mkdtemp(join(tmpdir(), "forge-clone-"));
    try {
      const target = join(into, "c");
      const cloned = await git(into, "clone", "--quiet", from, target);
      expect(cloned.code).toBe(0);
      const log = await git(target, "log", "--format=%s", "main");
      expect(log.code).toBe(0);
      const fsck = await git(target, "fsck", "--full");
      expect(fsck.code).toBe(0);
      return log.out.split("\n").reverse();
    } finally {
      await rm(into, { recursive: true, force: true });
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-delete-forks-"));
    app = createApp({ dataDir, port: 0 });
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("both forks still clone with every commit after the parent is gone", async () => {
    const { parent, dir, forks, fork } = await family();
    expect(await deleteRepo(app.db, app.reposRoot, parent)).toEqual({ ok: true, value: undefined });
    expect(existsSync(dir)).toBe(false);
    expect(getRepo(app.db, parent.ownerName, parent.name)).toBeUndefined();
    for (const f of forks) {
      expect(existsSync(join(fork(f), "objects", "info", "alternates"))).toBe(false);
      expect(await cloneSubjects(fork(f))).toEqual(subjects);
    }
  });

  test.skipIf(!unprivileged)("a fork that cannot be detached stops the delete and leaves everything whole", async () => {
    const { parent, dir, forks, fork } = await family();
    const pack = join(fork(forks[1]!), "objects", "pack");
    await chmod(pack, 0o555);
    try {
      const r = await deleteRepo(app.db, app.reposRoot, parent);
      expect(r).toEqual({ ok: false, error: "delete_failed" });
    } finally {
      await chmod(pack, 0o755);
    }
    expect(existsSync(dir)).toBe(true);
    expect(getRepo(app.db, parent.ownerName, parent.name)?.id).toBe(parent.id);
    expect(await cloneSubjects(dir)).toEqual(subjects);
    for (const f of forks) expect(await cloneSubjects(fork(f))).toEqual(subjects);
  });

  test.skipIf(!unprivileged)("a directory that cannot be removed answers delete_failed and keeps the row and the directory", async () => {
    n += 1;
    const owner = await user(`stuck${n}`);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: "stuck",
    });
    if (!made.ok) throw new Error("create failed");
    const dir = repoDir(app.reposRoot, made.value.ownerName, made.value.name);
    const holder = join(dir, "..");
    await chmod(holder, 0o555);
    try {
      expect(await deleteRepo(app.db, app.reposRoot, made.value)).toEqual({
        ok: false,
        error: "delete_failed",
      });
    } finally {
      await chmod(holder, 0o755);
    }
    expect(existsSync(dir)).toBe(true);
    expect(getRepo(app.db, made.value.ownerName, made.value.name)?.id).toBe(made.value.id);
  });
});
