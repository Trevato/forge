import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fullShard, scratchEnv, shardBase, shardHome, spaceLine, TEMP_FULL } from "../src/checks/disk_full.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";

const log = [
  "test/migrate-token-reach.test.ts:",
  "SQLiteError: database or disk is full",
  "(fail) migrate > pins [3ms]",
  "error: undefined is not an object",
  "(fail) test/migrate-token-reach.test.ts > (unnamed)",
  " 10 pass",
  " 2 fail",
];

test("a full shard is marked on the detail, and the failures stay in the summary", () => {
  const said = summariseCheckFailure(log, "exit 1");
  expect(said.detail?.environment).toBe(TEMP_FULL);
  expect(said.summary).toContain('"migrate > pins"');
  expect(summariseCheckFailure(["(fail) a", " 1 pass", " 1 fail"], "exit 1").detail?.environment).toBeUndefined();
});

test("the words alone are not the verdict: a test that prints them, or two named failures, stay the change's", () => {
  const prints = ["    expect(text).toContain(\"No space left on device\")", "(fail) a [1ms]", " 1 fail"];
  expect(fullShard(prints)).toBe(false);
  expect(fullShard(["(fail) a: expected ENOSPC", " 1 fail"])).toBe(false);
  const two = ["SQLiteError: database or disk is full", "(fail) one [1ms]", "(fail) two [1ms]", " 5 pass", " 2 fail"];
  expect(fullShard(two)).toBe(false);
  const said = summariseCheckFailure(two, "exit 1");
  expect(said.detail?.environment).toBeUndefined();
  expect(said.summary).toContain('"one" and "two"');
  expect(fullShard(["error: database or disk is full", "(fail) one [1ms]", "(fail) test/x.test.ts > (unnamed) [1ms]"])).toBe(true);
});

test("a shard keeps its temp on the cell's disk when the cell set one", () => {
  expect(shardBase({ FORGE_APP_DATA: "/cell/data" }, "/tmp")).toBe("/cell/data");
  expect(shardBase({}, "/tmp")).toBe("/tmp");
  expect(shardBase({ FORGE_CHECK_SCRATCH: "/home/run", FORGE_APP_DATA: "/cell/data" }, "/tmp")).toBe("/home/run");
});

test("a shard's home is made under the scratch, which need not exist yet", () => {
  const root = mkdtempSync(join(tmpdir(), "scratch-"));
  const scratch = join(root, "not", "yet");
  const home = shardHome({ FORGE_CHECK_SCRATCH: scratch }, "/nowhere");
  expect(home.startsWith(`${scratch}/shard-`)).toBe(true);
  expect(existsSync(home)).toBe(true);
  rmSync(root, { recursive: true, force: true });
});

test("the check service hands a cell's home to the shards, and nothing outside a cell", () => {
  expect(scratchEnv("/runs/1.home")).toEqual({ FORGE_CHECK_SCRATCH: "/runs/1.home" });
  expect(scratchEnv(undefined)).toEqual({});
});

test("the space line names each place's free room", () => {
  const line = spaceLine({ scratch: tmpdir(), gone: "/no/such/dir" });
  expect(line).toMatch(/scratch .*: \d+ MiB free of \d+ MiB/);
  expect(line).toContain("gone /no/such/dir: unreadable");
});
