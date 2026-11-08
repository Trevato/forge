import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo, deleteRepo, getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";

/**
 * deleteRepo keys presence on the directory, not on HEAD: a removal that died
 * partway (HEAD gone, a subdirectory stuck) keeps the row, and the retry
 * finishes the job instead of dropping the row over orphaned files.
 */

const root = process.getuid?.() === 0;

describe("deleteRepo after a partial removal", () => {
  let dataDir: string;
  let app: App;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-delpartial-"));
    app = createApp({ dataDir, port: 0 });
  });
  afterAll(async () => {
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test.skipIf(root)("a retry finishes what a failed removal left", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@f.dev",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error("user");
    const created = await createRepo(app.db, app.reposRoot, {
      ownerId: made.value.id,
      name: "stuck",
    });
    if (!created.ok) throw new Error("repo");
    const repo = created.value;
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);

    // HEAD is already gone; a locked subdirectory will not let rm finish.
    rmSync(join(dir, "HEAD"));
    const locked = join(dir, "objects");
    writeFileSync(join(locked, "keep"), "x");
    mkdirSync(join(locked, "sub"), { recursive: true });
    chmodSync(locked, 0o500);

    try {
      const first = await deleteRepo(app.db, app.reposRoot, repo);
      expect(first.ok).toBe(false);
      expect(existsSync(dir)).toBe(true);
      expect(getRepo(app.db, repo.ownerName, repo.name)).toBeDefined();
    } finally {
      chmodSync(locked, 0o700);
    }

    const second = await deleteRepo(app.db, app.reposRoot, repo);
    expect(second.ok).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(getRepo(app.db, repo.ownerName, repo.name)).toBeUndefined();
  });
});
