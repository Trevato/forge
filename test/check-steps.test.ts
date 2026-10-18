/**
 * A check's three step rows, read from the run's state and its log
 * (`checkSteps`, `src/checks/summary.ts`): what each row says while the
 * check runs, when it ends red at each step, when it is stopped, for a job
 * placed check, and for a log whose head was cut away.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stepsLine } from "../src/checks/progress.ts";
import { checkSteps } from "../src/checks/summary.ts";
import type { Run } from "../src/core/runs.ts";
import { appendRunLog } from "../src/runs/log.ts";

const read = (
  state: "queued" | "running" | "ok" | "failed" | "cancelled",
  lines: string[],
  opts: { placement?: string; truncated?: boolean } = {},
) =>
  checkSteps(
    { state, placement: opts.placement ?? "process" },
    lines,
    opts.truncated ?? false,
  ).map((s) => `${s.name}:${s.state}`);

const INSTALL = "$ bun install";
const CHECK = "$ gate && tsc && bun scripts/test-shards.ts";
const BANNER = "test-shards: 9 files";

describe("checkSteps", () => {
  test("a run that has logged nothing is waiting, then running install", () => {
    expect(read("queued", [])).toEqual([
      "install:pending",
      "typecheck:pending",
      "tests:pending",
    ]);
    expect(read("running", [INSTALL])).toEqual([
      "install:running",
      "typecheck:pending",
      "tests:pending",
    ]);
  });

  test("typecheck runs between the check's echo and the shard banner", () => {
    expect(read("running", [INSTALL, CHECK])).toEqual([
      "install:ok",
      "typecheck:running",
      "tests:pending",
    ]);
  });

  test("a red typecheck fails typecheck and leaves the tests unrun", () => {
    expect(read("failed", [INSTALL, CHECK, "src/a.ts(1,1): error TS2322"])).toEqual([
      "install:ok",
      "typecheck:failed",
      "tests:pending",
    ]);
  });

  test("a red install fails install", () => {
    expect(read("failed", [INSTALL, "error: no such package"])).toEqual([
      "install:failed",
      "typecheck:pending",
      "tests:pending",
    ]);
  });

  test("a repository with no install command starts at typecheck", () => {
    expect(read("running", [CHECK])).toEqual([
      "install:ok",
      "typecheck:running",
      "tests:pending",
    ]);
  });

  test("a cancelled run stops at the step it was on", () => {
    expect(read("cancelled", [INSTALL, CHECK, BANNER])).toEqual([
      "install:ok",
      "typecheck:ok",
      "tests:stopped",
    ]);
  });

  test("a passed run is passed at every step", () => {
    expect(read("ok", [CHECK])).toEqual([
      "install:ok",
      "typecheck:ok",
      "tests:ok",
    ]);
  });

  test("a job-placed check echoes every command first: install is done only once output follows", () => {
    expect(read("running", [INSTALL, CHECK], { placement: "job" })).toEqual([
      "install:running",
      "typecheck:pending",
      "tests:pending",
    ]);
    expect(
      read("running", [INSTALL, CHECK, "src/a.ts ok"], { placement: "job" }),
    ).toEqual(["install:ok", "typecheck:running", "tests:pending"]);
  });

  test("a truncated log whose tests cannot be seen reads unknown, not wrong", () => {
    expect(read("running", ["some late output"], { truncated: true })).toEqual([
      "install:unknown",
      "typecheck:unknown",
      "tests:unknown",
    ]);
    expect(
      read("running", ["── shard 2/4: test/a.test.ts"], { truncated: true }),
    ).toEqual(["install:ok", "typecheck:ok", "tests:running"]);
  });
});

describe("the terminal's step line", () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-steps-"));
  const run = { id: "r1", kind: "check", state: "running", placement: "process" } as Run;
  for (const l of [INSTALL, CHECK, BANNER]) appendRunLog(dir, "r1", l);

  test("reads the same rows as the page, through the same function", () => {
    expect(stepsLine(dir, { state: "running", run }, true)).toBe(
      "install passed · typecheck passed · tests running",
    );
    expect(
      stepsLine(dir, { state: "failed", run: { ...run, state: "failed" } }, true),
    ).toBe("install passed · typecheck passed · tests failed");
  });

  test("says nothing to a reader who may not read the log, nor for a deploy", () => {
    expect(stepsLine(dir, { state: "running", run }, false)).toBe("");
    expect(
      stepsLine(dir, { state: "running", run: { ...run, kind: "deploy" } }, true),
    ).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("install detection", () => {
  test("a script with install in its name is not the install", () => {
    expect(read("running", ["$ bun scripts/install-hooks.ts"])).toEqual([
      "install:ok",
      "typecheck:running",
      "tests:pending",
    ]);
  });
});
