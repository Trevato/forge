/**
 * A run's log lines wait a few milliseconds and are written together: the
 * live listeners hear each line at once, a reader of the file sees every
 * line (it writes what waits first), and a directory removed under the
 * writer is made again.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunLog,
  bufferRunLogs,
  flushRunLogs,
  readRunLog,
  runLogPath,
  runsRoot,
  subscribeRunLog,
} from "../src/runs/log.ts";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-runlog-"));
  bufferRunLogs(true);
});

afterAll(async () => {
  bufferRunLogs(false);
  await rm(dir, { recursive: true, force: true });
});

test("lines reach listeners at once and the file by the time anyone reads it", () => {
  const heard: string[] = [];
  const stop = new AbortController();
  subscribeRunLog("r1", (l) => heard.push(l), stop.signal);
  appendRunLog(dir, "r1", "one");
  appendRunLog(dir, "r1", "two\nstill two");
  appendRunLog(dir, "r2", "other");
  expect(heard).toEqual(["one", "two still two"]);
  expect(existsSync(runLogPath(dir, "r1"))).toBe(false);
  expect(readRunLog(dir, "r1").lines).toEqual(["one", "two still two"]);
  expect(readRunLog(dir, "r2").lines).toEqual(["other"]);
  stop.abort();
});

test("a timer writes lines nobody reads, in order", async () => {
  for (let n = 0; n < 5; n++) appendRunLog(dir, "r3", `line ${n}`);
  await Bun.sleep(150);
  expect(existsSync(runLogPath(dir, "r3"))).toBe(true);
  expect(await Bun.file(runLogPath(dir, "r3")).text()).toBe("line 0\nline 1\nline 2\nline 3\nline 4\n");
});

test("a removed directory is made again", () => {
  appendRunLog(dir, "r4", "first");
  flushRunLogs();
  rmSync(runsRoot(dir), { recursive: true, force: true });
  appendRunLog(dir, "r4", "after");
  expect(readRunLog(dir, "r4").lines).toEqual(["after"]);
});
