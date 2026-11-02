/**
 * A fork's Following card is a function of the two default tips (#6127):
 * warm reads do not ask git again, and a push to the parent changes the
 * next read.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { relationOf } from "../src/actions/forks.ts";
import { createApp, type App } from "../src/app.ts";
import { comparisons } from "../src/core/following.ts";
import { getRepo } from "../src/core/repos.ts";
import { getUserByName } from "../src/core/users.ts";
import { createUser } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";

let dataDir: string;
let app: App;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-following-cache-"));
  app = createApp({ dataDir, port: 0 });
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("warm reads do not compare again and a push to the parent changes the next read", async () => {
  const mk = async (username: string, first = false) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: first,
    });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await mk("alice", true);
  const bob = await mk("bob");
  promote(app.db, bob);
  const lib = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!lib.ok) throw new Error(String(lib.error));
  const commit = async (path: string) => {
    const r = await commitToBranch(app, alice, getRepo(app.db, "alice", "lib")!, {
      message: `Add ${path}`,
      files: [{ path, content: `${path}\n` }],
    });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  };
  await commit("a.txt");
  const forked = await forkRepo(app, bob, lib.value);
  if (!forked.ok) throw new Error(String(forked.error));
  const fork = getRepo(app.db, "bob", "lib")!;

  // Behind-only needs a git comparison; the first read pays for it.
  await commit("b.txt");
  const cold = await relationOf(app, bob, fork);
  expect(cold?.state).toBe("behind");
  expect(cold?.behind).toBe(1);

  const before = comparisons.count;
  const warm = await relationOf(app, bob, fork);
  expect(warm?.state).toBe("behind");
  expect(comparisons.count).toBe(before);

  await commit("c.txt");
  const moved = await relationOf(app, bob, fork);
  expect(moved?.parentTip).not.toBe(warm?.parentTip);
  expect(moved?.state).toBe("behind");
  expect(comparisons.count).toBe(before + 1);
}, 60_000);

test("readTip reads loose and packed refs without git, and declines the rest", async () => {
  const { readTip } = await import("../src/git/tip.ts");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = join(dataDir, "bare");
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  await mkdir(join(dir, "refs/heads"), { recursive: true });
  await writeFile(join(dir, "refs/heads/main"), `${a}\n`);
  await writeFile(join(dir, "packed-refs"), `# pack-refs\n${b} refs/heads/old\n^${a}\n`);
  expect(await readTip(dir, "refs/heads/main")).toBe(a);
  expect(await readTip(dir, "refs/heads/old")).toBe(b);
  expect(await readTip(dir, "refs/heads/none")).toBeUndefined();
  expect(await readTip(dir, "refs/tags/x")).toBeUndefined();
  await writeFile(join(dir, "refs/heads/sym"), "ref: refs/heads/main\n");
  expect(await readTip(dir, "refs/heads/sym")).toBeUndefined();
});

test("an answer git failed to give is not remembered", async () => {
  const { writeFile } = await import("node:fs/promises");
  const { repoDir } = await import("../src/git/repos.ts");
  const fork = getRepo(app.db, "bob", "lib")!;
  const bob = getUserByName(app.db, "bob")!;
  // A tip whose objects are missing: git cannot compare it with anything.
  await writeFile(
    join(repoDir(app.reposRoot, "bob", "lib"), `refs/heads/${fork.defaultBranch}`),
    `${"c".repeat(40)}\n`,
  );
  const before = comparisons.count;
  await relationOf(app, bob, fork);
  await relationOf(app, bob, fork);
  expect(comparisons.count).toBe(before + 2);
});
