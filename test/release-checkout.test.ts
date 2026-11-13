/**
 * A landing on the forge's own repository (#1662): the landed tree is written
 * to releases/<sha>/, preflighted, and recorded; the oldest is pruned; a red
 * preflight is recorded red and told to the pull. Another repository is left
 * alone.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { createApp, type App } from "../src/app.ts";
import { releaseOnLand } from "../src/checks/landing.ts";
import { listComments } from "../src/core/issues.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { recordCut } from "../src/keeper/record.ts";
import { releaseDir } from "../src/release/checkout.ts";
import { releaseEnv } from "../src/release/env.ts";
import { listReleases } from "../src/release/record.ts";

const GOOD = `if (process.argv.includes("--preflight")) { console.log("preflight ok: stand-in"); process.exit(0); }\n`;
const BAD = `if (process.argv.includes("--preflight")) { console.error("preflight failed: migration 9 broke"); process.exit(1); }\n`;

describe("release checkout on landing", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let forge: Repo;
  let pull: Pull;

  async function land(main: string, extra = "x"): Promise<string> {
    const made = await commitToBranch(app, alice, forge, {
      message: `land ${extra}`,
      files: [
        { path: "src/main.ts", content: main },
        { path: "marker.txt", content: extra },
      ],
    });
    if (!made.ok) throw new Error("commit");
    return made.value.commitOid;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-release-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge-code", releasesKeep: 2 });
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "a@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error("user");
    alice = u.value;
    const r = await createRepo(app, alice, { name: "forge-code", visibility: "public" });
    if (!r.ok) throw new Error("repo");
    forge = r.value;
    await commitToBranch(app, alice, forge, { message: "seed", files: [{ path: "a.txt", content: "a" }] });
    await commitToBranch(app, alice, forge, {
      message: "branch",
      branch: "change",
      files: [{ path: "b.txt", content: "b" }],
    });
    const opened = await openPull(app, alice, forge, {
      title: "a change",
      baseBranch: forge.defaultBranch,
      headBranch: "change",
    });
    if (!opened.ok) throw new Error("pull");
    pull = opened.value;
  }, 30_000);

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("writes that sha's files, preflights green, and records a row", async () => {
    const sha = await land(GOOD, "one");
    const release = await releaseOnLand(app, alice, forge, pull, sha);
    expect(release).toMatchObject({ sha, ok: true, pullNumber: pull.number });
    expect(readFileSync(join(releaseDir(dataDir, sha), "marker.txt"), "utf8")).toBe("one");
    expect(existsSync(join(releaseDir(dataDir, sha), ".git"))).toBe(false);
    expect(listReleases(app.db)[0]).toMatchObject({ sha, ok: true });
  }, 30_000);

  test("is idempotent for a sha already checked out", async () => {
    const [row] = listReleases(app.db);
    const again = await releaseOnLand(app, alice, forge, pull, row!.sha);
    expect(again?.ok).toBe(true);
    expect(readdirSync(join(dataDir, "releases"))).toEqual([row!.sha]);
  }, 30_000);

  test("keeps the last N and prunes the oldest", async () => {
    const first = listReleases(app.db)[0]!.sha;
    // Age the first so the order does not hang on clock resolution.
    const old = new Date(Date.now() - 60_000);
    utimesSync(releaseDir(dataDir, first), old, old);
    const second = await land(GOOD, "two");
    await releaseOnLand(app, alice, forge, pull, second);
    const third = await land(GOOD, "three");
    await releaseOnLand(app, alice, forge, pull, third);
    const kept = readdirSync(join(dataDir, "releases")).sort();
    expect(kept).toEqual([second, third].sort());
    expect(existsSync(releaseDir(dataDir, first))).toBe(false);
  }, 60_000);

  test("never prunes the release keeper's known-good tree, however old (#11801)", async () => {
    const good = listReleases(app.db)[0]!.sha;
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(releaseDir(dataDir, good), old, old);
    recordCut(app.db, { version: "0.7.9", sha: "f".repeat(40), knownGood: { version: "0.7.8", image: `tree/${good}:0.7.8` }, at: Date.now() });
    for (const n of ["four", "five"]) {
      const sha = await land(GOOD, n);
      await releaseOnLand(app, alice, forge, pull, sha);
    }
    expect(existsSync(releaseDir(dataDir, good))).toBe(true);
    expect(readdirSync(join(dataDir, "releases")).filter((d) => /^[0-9a-f]{40}$/.test(d))).toHaveLength(3);
  }, 60_000);

  test("a failing preflight is recorded red, logged, and told to the pull", async () => {
    const sha = await land(BAD, "red");
    const release = await releaseOnLand(app, alice, forge, pull, sha);
    expect(release).toMatchObject({ sha, ok: false });
    expect(release?.line).toContain("migration 9 broke");
    const told = listComments(app.db, pull.id).map((c) => c.body);
    expect(told.some((b) => b.includes(sha.slice(0, 12)) && b.includes("migration 9 broke"))).toBe(true);
  }, 30_000);

  test("a red the second attempt clears is recorded green and not told", async () => {
    // Fails once (a torn copy), then passes: the marker lives in the release dir.
    const flaky = `import { existsSync, writeFileSync } from "node:fs";
if (process.argv.includes("--preflight")) {
  if (!existsSync("tried")) { writeFileSync("tried", "1"); console.error("preflight failed: torn copy"); process.exit(1); }
  console.log("preflight ok: second try"); process.exit(0);
}\n`;
    const sha = await land(flaky, "flaky");
    const before = listComments(app.db, pull.id).length;
    const release = await releaseOnLand(app, alice, forge, pull, sha);
    expect(release).toMatchObject({ sha, ok: true });
    expect(release?.line).toContain("second try");
    expect(listComments(app.db, pull.id)).toHaveLength(before);
  }, 30_000);

  test("another repository is untouched", async () => {
    const other = await createRepo(app, alice, { name: "notes", visibility: "public" });
    if (!other.ok) throw new Error("other");
    const made = await commitToBranch(app, alice, other.value, {
      message: "n",
      files: [{ path: "src/main.ts", content: GOOD }],
    });
    if (!made.ok) throw new Error("commit");
    const before = listReleases(app.db).length;
    const dirs = readdirSync(join(dataDir, "releases")).sort();
    expect(await releaseOnLand(app, alice, other.value, pull, made.value.commitOid)).toBeUndefined();
    expect(listReleases(app.db)).toHaveLength(before);
    expect(readdirSync(join(dataDir, "releases")).sort()).toEqual(dirs);
  });
});

describe("overlapping landings", () => {
  test("two landings at once both finish, and a young partial survives a prune", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-release-race-"));
    const app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge-code", releasesKeep: 5 });
    try {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "a@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error("user");
      const r = await createRepo(app, u.value, { name: "forge-code", visibility: "public" });
      if (!r.ok) throw new Error("repo");
      const shas: string[] = [];
      for (const n of ["one", "two"]) {
        const c = await commitToBranch(app, u.value, r.value, {
          message: n,
          files: [{ path: "src/main.ts", content: GOOD }, { path: "n.txt", content: n }],
        });
        if (!c.ok) throw new Error("commit");
        shas.push(c.value.commitOid);
      }
      await commitToBranch(app, u.value, r.value, {
        message: "b",
        branch: "change",
        files: [{ path: "b.txt", content: "b" }],
      });
      const opened = await openPull(app, u.value, r.value, {
        title: "t",
        baseBranch: r.value.defaultBranch,
        headBranch: "change",
      });
      if (!opened.ok) throw new Error("pull");
      // A staging directory a live checkout is writing must not be swept.
      const root = join(dataDir, "releases");
      mkdirSync(join(root, ".live.partial"), { recursive: true });
      const out = await Promise.all(
        shas.map((sha) => releaseOnLand(app, u.value, r.value, opened.value, sha)),
      );
      expect(out.map((x) => x?.ok)).toEqual([true, true]);
      expect(existsSync(join(root, ".live.partial"))).toBe(true);
      for (const sha of shas) expect(existsSync(join(releaseDir(dataDir, sha), "n.txt"))).toBe(true);
      expect(listReleases(app.db).map((x) => x.sha).sort()).toEqual([...shas].sort());
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("release environment", () => {
  test("a repository is owner/name; the keep count is an integer of at least one", () => {
    expect(releaseEnv({ FORGE_REPO: "a/b.c", FORGE_RELEASES_KEEP: "3" })).toEqual({ forgeRepo: "a/b.c", releasesKeep: 3 });
    expect(releaseEnv({})).toEqual({});
    expect(releaseEnv({ FORGE_REPO: "nope", FORGE_RELEASES_KEEP: "0" })).toEqual({});
    expect(releaseEnv({ FORGE_REPO: "a/b/c", FORGE_RELEASES_KEEP: "2.5" })).toEqual({});
    expect(releaseEnv({ FORGE_RELEASES_KEEP: "" })).toEqual({});
  });
});
