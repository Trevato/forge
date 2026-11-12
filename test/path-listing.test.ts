/** Path listings kept by tree id: a second ask reuses the first, a moved branch never reads stale. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keptListings, pathsAtTree } from "../src/git/path_listing.ts";
import { closeReader } from "../src/git/read.ts";

let dir: string;
const git = (...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};
const commit = async (file: string) => {
  await writeFile(join(dir, file), file);
  git("add", file);
  git("commit", "-qm", file);
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-path-listing-"));
  git("init", "-q", "-b", "main");
  await commit("a.ts");
});

afterAll(async () => {
  closeReader(dir);
  await rm(dir, { recursive: true, force: true });
});

test("the same tree asked twice is listed once: the second answer is the kept one", async () => {
  const first = await pathsAtTree(dir, "main");
  const before = keptListings();
  const second = await pathsAtTree(dir, "main");
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(first.value.paths).toEqual(["a.ts"]);
  expect(second.value).toBe(first.value);
  expect(keptListings()).toBe(before);
});

test("a branch that moves names a new tree, so its listing is fresh", async () => {
  await pathsAtTree(dir, "main");
  await commit("b.ts");
  const moved = await pathsAtTree(dir, "main");
  expect(moved.ok && moved.value.paths).toEqual(["a.ts", "b.ts"]);
});

test("a ref that names nothing is missing, and an unsafe one never reaches git", async () => {
  expect((await pathsAtTree(dir, "nope")).ok).toBe(false);
  expect((await pathsAtTree(dir, "-x")).ok).toBe(false);
});
