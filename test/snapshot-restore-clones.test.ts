/**
 * A restore clones its repositories several at a time (#2543): a forge of
 * hundreds spent the drill's minutes cloning one after another. Every
 * repository still comes back, and one bundle git refuses fails the
 * restore by name.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../src/git/env.ts";
import { err } from "../src/kernel/result.ts";
import { CLONES, restoreSnapshot } from "../src/snapshot/restore.ts";
import { dirStore, type Store } from "../src/snapshot/store.ts";

const NAME = "2026-10-18T08-00-00Z";
const prefix = `snapshots/${NAME}/`;
const REPOS = 11;

async function seed(store: Store, root: string, broken?: number): Promise<void> {
  const src = join(root, "src");
  if (!existsSync(src)) {
    await runGit(["init", "--quiet", src]);
    await Bun.write(join(src, "a.txt"), "hello\n");
    await runGit(["add", "."], { cwd: src });
    await runGit(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "one"], { cwd: src });
    await runGit(["bundle", "create", join(root, "ok.bundle"), "--all"], { cwd: src });
  }
  const good = new Uint8Array(await Bun.file(join(root, "ok.bundle")).arrayBuffer());
  const files: { path: string; bytes: number }[] = [];
  for (let n = 0; n < REPOS; n++) {
    const path = `repos/alice/r${n}.bundle`;
    const body = n === broken ? new TextEncoder().encode("not a bundle") : good;
    await store.put(prefix + path, body);
    files.push({ path, bytes: body.byteLength });
  }
  await store.put(
    `${prefix}manifest.json`,
    JSON.stringify({
      name: NAME,
      startedAt: "2026-10-18T08:00:00.000Z",
      finishedAt: "2026-10-18T08:01:00.000Z",
      version: "t",
      repos: REPOS,
      apps: 0,
      files,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      key: "raw",
    }),
  );
}

describe("a restore clones in parallel", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "forge-restore-clones-"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("every repository comes back with its history", async () => {
    const store = dirStore(join(root, "store-1"));
    await seed(store, root);
    const dataDir = join(root, "data-1");
    const done = await restoreSnapshot(store, NAME, dataDir);
    expect(done.repos).toBe(REPOS);
    for (let n = 0; n < REPOS; n++) {
      const dir = join(dataDir, "repos", "alice", `r${n}.git`);
      expect(existsSync(dir)).toBe(true);
      const log = await runGit(["log", "--format=%s"], { cwd: dir });
      expect(log.ok && log.value.trim()).toBe("one");
    }
    expect(existsSync(join(dataDir, "restore-bundles"))).toBe(false);
    expect(readFileSync(join(dataDir, "repos", "alice", "r0.git", "HEAD"), "utf8")).toContain("ref:");
  });

  test("several clones run at once, never more than CLONES", async () => {
    const store = dirStore(join(root, "store-3"));
    await seed(store, root);
    let open = 0;
    let most = 0;
    const git: typeof runGit = async (args, options) => {
      const cloning = args[0] === "clone";
      if (cloning) {
        open++;
        most = Math.max(most, open);
        await Bun.sleep(30);
      }
      try {
        return await runGit(args, options);
      } finally {
        if (cloning) open--;
      }
    };
    const done = await restoreSnapshot(store, NAME, join(root, "data-3"), { git });
    expect(done.repos).toBe(REPOS);
    expect(CLONES).toBe(4);
    expect(most).toBe(4);
  });

  test("a bundle git refuses fails the restore, by name", async () => {
    const store = dirStore(join(root, "store-2"));
    await seed(store, root, 6);
    await expect(restoreSnapshot(store, NAME, join(root, "data-2"))).rejects.toThrow(
      "could not restore alice/r6",
    );
  });

  test("of clones that fail together, the refusal names the earliest in the manifest", async () => {
    const store = dirStore(join(root, "store-4"));
    await seed(store, root);
    // r0 is refused last, r2 at once: the error still names r0.
    const git: typeof runGit = async (args, options) => {
      if (args[0] === "clone" && args[3]?.endsWith("alice--r0.bundle")) {
        await Bun.sleep(60);
        return err({ code: 128, stderr: "slow refusal", args });
      }
      if (args[0] === "clone" && args[3]?.endsWith("alice--r2.bundle"))
        return err({ code: 128, stderr: "fast refusal", args });
      return runGit(args, options);
    };
    await expect(restoreSnapshot(store, NAME, join(root, "data-4"), { git })).rejects.toThrow(
      "could not restore alice/r0: slow refusal",
    );
  });
});
