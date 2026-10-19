/**
 * Telling the owner (#2633): a new parent tip in `tell-me` is one inbox card,
 * never repeated for the same tip; `take-updates` and a severed link get none.
 * Two local bare repositories, no network.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listAssignedTo } from "../src/core/issues.ts";
import { createUser } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
import { checkUpstream } from "../src/spawn/upstream.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const git = async (cwd: string, ...args: string[]) => {
  const r = await runGit(["-c", "user.name=t", "-c", "user.email=t@x.invalid", ...args], { cwd });
  if (!r.ok) throw new Error(r.error.stderr);
  return r.value;
};

describe("the parent moved: one card", () => {
  let dir = "";
  let app: App;
  let parent = "";
  let work = "";
  let ownerId = "";

  const commit = async (n: number) => {
    await Bun.write(join(work, `f${n}.txt`), String(n));
    await git(work, "add", ".");
    await git(work, "commit", "-m", `c${n}`);
    await git(work, "push", "-q", parent, "HEAD:refs/heads/main");
  };
  const link = async (patch: Record<string, unknown>) => {
    const file = join(app.config.dataDir, "parent.json");
    const doc = await Bun.file(file).json();
    Object.assign(doc.forgeCode, patch);
    await Bun.write(file, JSON.stringify(doc));
  };
  const cards = () => listAssignedTo(app.db, ownerId).map((i) => i.title);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-upcard-"));
    app = createApp({ dataDir: join(dir, "data"), url: "https://child.test", port: 0 });
    parent = join(dir, "parent.git");
    work = join(dir, "work");
    await git(dir, "init", "-q", "--bare", "-b", "main", parent);
    await git(dir, "init", "-q", "-b", "main", work);
    await commit(0);
    const owner = await createUser(app.db, { origin: "seed", trusted: true, username: "kid", email: "k@x.test", isAdmin: true });
    if (!owner.ok) throw new Error("no owner");
    ownerId = owner.value.id;
    const made = await createRepo(app, owner.value, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error("no repo");
    await rm(repoDir(app.reposRoot, "kid", "forge"), { recursive: true, force: true });
    await mkdir(join(app.reposRoot, "kid"), { recursive: true });
    await git(dir, "clone", "-q", "--bare", parent, repoDir(app.reposRoot, "kid", "forge"));
    await Bun.write(
      join(app.config.dataDir, "parent.json"),
      JSON.stringify({
        upstream: "https://parent.test",
        forgeCode: { repo: "kid/forge", upstream: "root/forge", mode: "tell-me", tip: "a".repeat(40), chain: [] },
      }),
    );
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("up to date: no card", async () => {
    await checkUpstream(app, { remote: parent });
    expect(cards()).toEqual([]);
  });

  test("a new tip is one card that links the chain page; the same tip adds none", async () => {
    for (const n of [1, 2]) await commit(n);
    await checkUpstream(app, { remote: parent });
    expect(cards()).toEqual(["Your parent forge has 2 new commits"]);
    expect(listAssignedTo(app.db, ownerId)[0]!.body).toContain("(/kid/forge/following)");
    await checkUpstream(app, { remote: parent });
    expect(cards()).toHaveLength(1);
  });

  test("a failed check in between does not make the next one repeat", async () => {
    await checkUpstream(app, { remote: join(dir, "nowhere.git") });
    await checkUpstream(app, { remote: parent });
    expect(cards()).toHaveLength(1);
  });

  test("a later tip is a second card", async () => {
    await commit(3);
    await checkUpstream(app, { remote: parent });
    expect(cards()).toContain("Your parent forge has 3 new commits");
    expect(cards()).toHaveLength(2);
  });

  test("take-updates gets none", async () => {
    await link({ mode: "take-updates" });
    await commit(4);
    await checkUpstream(app, { remote: parent });
    expect(cards()).toHaveLength(2);
  });

  test("severed gets none", async () => {
    await link({ mode: "tell-me", severedAt: new Date().toISOString() });
    await commit(5);
    await checkUpstream(app, { remote: parent });
    expect(cards()).toHaveLength(2);
  });
});
