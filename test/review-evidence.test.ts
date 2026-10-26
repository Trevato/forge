/** `/review`'s diff stat: cached per base and head, never waited on, stopped with the app. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { diffStatFor, parseNumstat, settled } from "../src/web/studio/review_evidence.ts";

let root = "";
let base = "";
let head = "";
const repo = { ownerName: "o", name: "r" };
const pullOf = (b: string, h: string) =>
  ({ baseOid: b, headOid: h, sealed: false, crossRepo: false, headRepoId: "", baseBranch: "main" }) as const;
const fakeApp = () => ({ closing: new AbortController(), reposRoot: root, db: null }) as unknown as App;

const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
  return r.stdout.toString().trim();
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "forge-evidence-"));
  const dir = join(root, "o", "r.git");
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--bare", "-b", "main");
  const work = join(root, "work");
  mkdirSync(work);
  git(work, "init", "-b", "main");
  writeFileSync(join(work, "a.txt"), "one\ntwo\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "base");
  base = git(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "a.txt"), "one\n");
  writeFileSync(join(work, "b.txt"), "x\ny\nz\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "head");
  head = git(work, "rev-parse", "HEAD");
  git(work, "push", dir, "main");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function countSpawns<T>(f: () => Promise<T>): Promise<{ value: T; spawns: number }> {
  const real = Bun.spawn;
  let spawns = 0;
  (Bun as { spawn: unknown }).spawn = ((...a: unknown[]) => (spawns++, (real as (...x: unknown[]) => unknown)(...a))) as unknown;
  return f().then((value) => ({ value, spawns })).finally(() => ((Bun as { spawn: unknown }).spawn = real));
}

test("numstat totals count files, lines and binary files", () => {
  expect(parseNumstat("3\t1\ta\n-\t-\tb.png\n")).toEqual({ files: 2, additions: 3, deletions: 1 });
});

test("a cold request is loading and computes in the background; a warm one makes no git reads", async () => {
  const app = fakeApp();
  expect(diffStatFor(app, repo, pullOf(base, head))).toBe("loading");
  await settled(app);
  const warm = await countSpawns(async () => diffStatFor(app, repo, pullOf(base, head)));
  expect(warm.value).toEqual({ files: 2, additions: 3, deletions: 1 });
  expect(warm.spawns).toBe(0);
});

test("calls while the first is running share it: git is spawned once", async () => {
  const app = fakeApp();
  const r = await countSpawns(async () => {
    const seen = [1, 2, 3].map(() => diffStatFor(app, repo, pullOf(base, head)));
    await settled(app);
    seen.push(diffStatFor(app, repo, pullOf(base, head)));
    return seen;
  });
  expect(r.spawns).toBe(1);
  expect(r.value.slice(0, 3)).toEqual(["loading", "loading", "loading"]);
  expect(r.value[3]).toEqual({ files: 2, additions: 3, deletions: 1 });
});

test("a failed stat says failed and is not asked again within the retry window", async () => {
  const app = fakeApp();
  const missing = "1".repeat(40);
  const r = await countSpawns(async () => {
    expect(diffStatFor(app, repo, pullOf(base, missing))).toBe("loading");
    await settled(app);
    return [diffStatFor(app, repo, pullOf(base, missing)), diffStatFor(app, repo, pullOf(base, missing))];
  });
  expect(r.value).toEqual(["failed", "failed"]);
  expect(r.spawns).toBe(1);
});

test("an oid git would not take is failed without a process", async () => {
  const app = fakeApp();
  const r = await countSpawns(async () => diffStatFor(app, repo, pullOf(base, "--output=x")));
  expect(r.value).toBe("failed");
  expect(r.spawns).toBe(0);
});

test("at most four run at once, and closing the app stops the work and starts none", async () => {
  const app = fakeApp();
  const real = Bun.spawn;
  let live = 0;
  let peak = 0;
  (Bun as { spawn: unknown }).spawn = ((...a: unknown[]) => {
    const p = (real as (...x: unknown[]) => { exited: Promise<number> })(...a);
    peak = Math.max(peak, ++live);
    void p.exited.then(() => live--);
    return p;
  }) as unknown;
  try {
    for (let i = 0; i < 10; i++) diffStatFor(app, repo, pullOf(base, i.toString(16).repeat(40).slice(0, 40)));
    app.closing.abort();
    await settled(app);
    expect(peak).toBeLessThanOrEqual(4);
    expect(live).toBe(0);
    const before = live;
    diffStatFor(app, repo, pullOf(base, head));
    await settled(app);
    expect(live).toBe(before);
    expect(diffStatFor(app, repo, pullOf(base, head))).toBe("loading");
  } finally {
    (Bun as { spawn: unknown }).spawn = real;
  }
});
