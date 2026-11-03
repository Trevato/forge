/**
 * A repository's own check, run by the forge: `check` in forge.json, on
 * every push a pull or the default branch takes, the verdict a run beside
 * the pull — the same place a preview's deploy reports.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull, submitReview } from "../src/actions/pulls.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { parseBunTestFailure } from "../src/checks/bun-test.ts";
import { summariseCheckFailure } from "../src/checks/summary.ts";
import { SLOW_SECONDS, summaryLines } from "../scripts/gate-summary.ts";
import { tally } from "../scripts/shards.ts";
import {
  holdsLastSlot,
  pickNext,
  requeueAbandonedChecks,
  startChecks,
  sweepSoon,
  STARVATION_MS,
  type ChecksHandle,
} from "../src/checks/service.ts";
import {
  cancelRun,
  cancelRunsForPull,
  CHECK_RESTART_LIMIT,
  checkSummary,
  checksForHead,
  claimRun,
  createRun,
  getRun,
  listRuns,
  REQUEUED_SUMMARY,
  type Run,
} from "../src/core/runs.ts";
import type { Pull } from "../src/core/pulls.ts";
import { checksText } from "../src/tui/screens/pull.ts";
import { checksLine } from "../src/web/pages/pull.ts";
import { repoDir } from "../src/git/repos.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { pullWord, servingHistory } from "../src/web/studio/words.ts";
import { createUser, type User } from "../src/core/users.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";
import { readRunLog } from "../src/runs/log.ts";
import { promote } from "./helpers/members.ts";

const checkJson = (run: string, extra = ""): string =>
  `{"check": {"run": ${JSON.stringify(run)}, "install": ""${extra}}}\n`;

describe("cancelRunsForPull: a landed or closed pull leaves nothing in the lane", () => {
  test("queued and running checks and queued deploys of that pull are cancelled, building deploys and other pulls kept", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-cancel-"));
    const db = createApp({ dataDir: dir, port: 0 });
    try {
      const u = await createUser(db.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(db, u.value, { name: "lib" });
      if (!made.ok) throw new Error(String(made.error));
      const repoId = made.value.id;
      const first = await commitToBranch(db, u.value, made.value, {
        message: "Start",
        files: [{ path: "README.md", content: "x\n" }],
      });
      if (!first.ok) throw new Error(JSON.stringify(first.error));
      const pullOn = async (branch: string): Promise<string> => {
        const c = await commitToBranch(db, u.value, made.value, {
          branch,
          message: branch,
          files: [{ path: `${branch}.md`, content: "x\n" }],
        });
        if (!c.ok) throw new Error(JSON.stringify(c.error));
        const o = await openPull(db, u.value, made.value, {
          title: branch,
          baseBranch: "main",
          headBranch: branch,
        });
        if (!o.ok) throw new Error(String(o.error));
        return o.value.id;
      };
      const p1 = await pullOn("one");
      const p2 = await pullOn("two");
      const mk = (kind: "check" | "deploy", issueId: string) =>
        createRun(db.db, { repoId, kind, env: "pull-1", issueId });
      const queued = mk("check", p1);
      const running = mk("check", p1);
      claimRun(db.db, running.id);
      const deploy = mk("deploy", p1);
      const building = mk("deploy", p1);
      claimRun(db.db, building.id);
      const other = mk("check", p2);
      const stopped = cancelRunsForPull(db.db, p1, "pull landed");
      expect(stopped.map((r) => r.id).sort()).toEqual(
        [queued.id, running.id, deploy.id].sort(),
      );
      // A building deploy is the runtime's to stop; the row must not say otherwise.
      expect(getRun(db.db, building.id)?.state).toBe("running");
      for (const r of [queued, running, deploy]) {
        expect(getRun(db.db, r.id)?.state).toBe("cancelled");
        expect(getRun(db.db, r.id)?.summary).toBe("pull landed");
      }
      expect(getRun(db.db, other.id)?.state).toBe("queued");
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseBunTestFailure: a convenience over one known runner, not a general protocol", () => {
  test("bun test's own tail: the counts, and the failing names bounded to a few", () => {
    const lines = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "check.test.ts:",
      "(fail) first [0.16ms]",
      "(fail) second [0.07ms]",
      "(fail) third [0.05ms]",
      "(fail) fourth [0.04ms]",
      "",
      " 3 pass",
      " 4 fail",
      " 7 expect() calls",
      "Ran 7 tests across 1 file. [51.00ms]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 3,
      failed: 4,
      names: ["first", "second", "third"],
    });
  });

  test("a name arbitrary text from a subprocess, kept verbatim — escaping is the page's job, not the parser's", () => {
    const lines = [
      "(fail) <script>alert(1)</script> [1.00ms]",
      " 0 pass",
      " 1 fail",
      "Ran 1 test across 1 file. [1.00ms]",
    ];
    expect(parseBunTestFailure(lines)?.names).toEqual([
      "<script>alert(1)</script>",
    ]);
  });

  test("a failing test bun printed without a duration — as it does under CI for one that took no time — is still named", () => {
    const lines = [
      "(pass) a passing test",
      "(fail) first failing test [0.10ms]",
      "(fail) second failing test",
      " 1 pass",
      " 2 fail",
      "Ran 3 tests across 1 file. [9.00ms]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 1,
      failed: 2,
      names: ["first failing test", "second failing test"],
    });
  });

  test("a shard's named failure leads; the (unnamed) fallout behind it is not named", () => {
    const lines = [
      "── shard 1/1 (exit 1, 3s): test/a.test.ts",
      "test/a.test.ts:",
      "(fail) a > writes the row [2ms]",
      "error: database is closed",
      "(fail) (unnamed) [1ms]",
      " 4 pass",
      " 2 fail",
    ];
    expect(parseBunTestFailure(lines)?.names).toEqual(["a > writes the row"]);
    // Only a shard that named nothing else is named by its fallout.
    const only = ["test/b.test.ts:", "error: boom", "(fail) (unnamed)", " 0 pass", " 1 fail"];
    expect(parseBunTestFailure(only)?.names).toEqual(["test/b.test.ts > (unnamed): error: boom"]);
  });

  test("shards that finished out of order are named in shard order, each shard's first failure first", () => {
    const lines = [
      "── shard 3/3 (exit 1, 2s): test/c.test.ts",
      "test/c.test.ts:",
      "(fail) c one [1ms]",
      "(fail) c two [1ms]",
      " 1 pass",
      " 2 fail",
      "── shard 1/3 (exit 1, 9s): test/a.test.ts",
      "test/a.test.ts:",
      "error: boom",
      "(fail) (unnamed) [1ms]",
      " 3 pass",
      " 1 fail",
      "── shard 2/3 (exit 0, 5s): test/b.test.ts",
      " 7 pass",
      " 0 fail",
      "2 of 3 shards failed:",
      "(fail) test/a.test.ts > (unnamed): error: boom [1ms] [shard 1]",
      "(fail) c one [1ms] [shard 3]",
      "(fail) c two [1ms] [shard 3]",
    ];
    expect(parseBunTestFailure(lines)).toEqual({
      passed: 11,
      failed: 3,
      names: ["test/a.test.ts > (unnamed): error: boom", "c one", "c two"],
    });
  });

  test("output that is not bun test's own shape is not guessed at", () => {
    expect(
      parseBunTestFailure([
        "$ test -f NOPE.md",
        "test: NOPE.md: No such file or directory",
      ]),
    ).toBeUndefined();
    // A `pass` line with no `fail` line beside it is not this shape either.
    expect(
      parseBunTestFailure([" 5 pass", "Ran 5 tests across 1 file."]),
    ).toBeUndefined();
    // All green: nothing failed, so there is nothing to summarise.
    expect(
      parseBunTestFailure([" 5 pass", " 0 fail", "Ran 5 tests across 1 file."]),
    ).toBeUndefined();
  });
});

describe("summariseCheckFailure: what a failed check's summary says first", () => {
  test("real bun test output with one failure yields the name and the counts", () => {
    const lines = [
      "bun test v1.3.14 (0d9b296a)",
      "",
      "check.test.ts:",
      "1 tests failed:",
      "(fail) the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed [30000.49ms]",
      "  ^ this test timed out after 30000ms.",
      "",
      " 409 pass",
      " 1 fail",
      "Ran 410 tests across 1 file. [30.05s]",
    ];
    expect(summariseCheckFailure(lines, "check exited with code 1")).toEqual({
      summary:
        "1 of 410 tests — \"the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed\"",
      detail: {
        passed: 409,
        failed: 1,
        names: [
          "the forge's own restart never reads as this deploy's failure (issue #255) > an install still in flight when the runtime stops finishes cancelled, not failed",
        ],
      },
    });
  });

  test("output with no bun test shape yields the last non-empty line, not the bare exit code", () => {
    const lines = ["src/foo.ts(10,5): error TS2345: not assignable", ""];
    expect(summariseCheckFailure(lines, "check exited with code 2")).toEqual({
      summary: "src/foo.ts(10,5): error TS2345: not assignable",
      detail: undefined,
    });
  });

  test("no output at all falls back to the bare exit code — nothing was there to name", () => {
    expect(summariseCheckFailure([], "check exited with code 1")).toEqual({
      summary: "check exited with code 1",
      detail: undefined,
    });
  });

  const failing = (n: number) => [
    ...Array.from({ length: n }, (_, i) => `(fail) t${i + 1} [1.00ms]`),
    " 5 pass",
    ` ${n} fail`,
  ];

  test("three failures name all three; five name three and how many more", () => {
    expect(summariseCheckFailure(failing(3), "x").summary).toBe(
      '3 of 8 tests — "t1", "t2" and "t3"',
    );
    expect(summariseCheckFailure(failing(5), "x").summary).toBe(
      '5 of 10 tests — "t1", "t2", "t3" and 2 more',
    );
  });

  test("a name list longer than the limit is still bounded to one line", () => {
    const long = "y".repeat(100);
    const lines = ["a", "b", "c", "d"].map((c) => `(fail) ${c}${long} [1.00ms]`);
    const { summary } = summariseCheckFailure([...lines, " 0 pass", " 4 fail"], "x");
    expect(summary.length).toBe(200);
    expect(summary.endsWith("…")).toBe(true);
  });

  test("a very long name is bounded to one line", () => {
    const long = "x".repeat(500);
    const lines = [`(fail) ${long} [1.00ms]`, " 0 pass", " 1 fail"];
    const { summary } = summariseCheckFailure(
      lines,
      "check exited with code 1",
    );
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});

describe("summariseCheckFailure: a red gate is summarised by its red test, never a warning line (#2271)", () => {
  // The sharded gate's log, as `scripts/test-shards.ts` prints it: each
  // shard's own bun test output whole, the red one first, then the tally,
  // then the gate summary block with its slow-file warning.
  const red =
    "bun test v1.3.14\n\ntest/standards.test.ts:\n(pass) the README names every script [1.00ms]\n" +
    "(fail) releases.json is the shipped releases > every entry is a release [3.00ms]\n\n" +
    " 11 pass\n 1 fail\n 40 expect() calls\nRan 12 tests across 1 file. [80.00ms]\n";
  const slow =
    "bun test v1.3.14\n\ntest/crew.test.ts:\n(pass) a crew is listed [2.00ms]\n\n" +
    " 30 pass\n 0 fail\n 90 expect() calls\nRan 30 tests across 1 file. [52.40s]\n";
  const results = [
    { files: ["test/standards.test.ts"], code: 1, output: red, seconds: 1.2 },
    { files: ["test/crew.test.ts"], code: 0, output: slow, seconds: 52.5 },
  ];
  const block = (times: { file: string; seconds: number }[]): string[] =>
    summaryLines({
      shards: 2,
      cpus: 16,
      shardsMax: 16,
      files: 2,
      override: undefined,
      memoryBytes: 8 * 1024 ** 3,
      workerBytes: 1024 ** 3,
      memory: { limit: undefined, peak: undefined },
      wallSeconds: 52.6,
      times,
    });
  const log = (shards: typeof results): string[] => [
    ...shards.flatMap((r, i) => [`── shard ${i + 1}/2 (exit ${r.code}, ${r.seconds}s): ${r.files[0]}`, ...r.output.split("\n")]),
    ...tally(shards, 52.6).lines,
    "",
    ...block(shards.map((r) => ({ file: r.files[0]!, seconds: r.seconds }))),
  ];

  test("one red file and one slow file: the summary is the red file's test", () => {
    const lines = log(results);
    expect(lines.at(-1)).toBe(`test-shards: over ${SLOW_SECONDS} s: test/crew.test.ts (52.5s)`);
    expect(summariseCheckFailure(lines, "check exited with code 1")).toEqual({
      summary: '1 of 42 tests — "releases.json is the shipped releases > every entry is a release"',
      detail: {
        passed: 41,
        failed: 1,
        names: ["releases.json is the shipped releases > every entry is a release"],
      },
    });
  });

  test("a red shard that named no test is named by its files, not by the gate summary block", () => {
    const crashed = [
      { files: ["test/standards.test.ts"], code: 137, output: "bun test v1.3.14\n", seconds: 1.2 },
      results[1]!,
    ];
    expect(summariseCheckFailure(log(crashed), "check exited with code 1").summary).toBe(
      "shard 1 exited 137 without naming a test: test/standards.test.ts",
    );
  });

  test("a killed shard's line is the summary, and the old line is still recognised", () => {
    expect(
      summariseCheckFailure(["shard 258 killed after 412 s, running test/x.test.ts"], "check exited with code 1").summary,
    ).toBe("shard 258 killed after 412 s, running test/x.test.ts");
    expect(
      summariseCheckFailure(["shard 258 exited 143 without naming a test: a b"], "check exited with code 1").summary,
    ).toBe("shard 258 exited 143 without naming a test: a b");
  });

  test("without names or a tally, the last line before the gate summary block, never a line of it", () => {
    const lines = ["test-shards: something went wrong", "", ...block([{ file: "test/crew.test.ts", seconds: 52.5 }])];
    expect(summariseCheckFailure(lines, "check exited with code 1").summary).toBe(
      "test-shards: something went wrong",
    );
  });
});

describe("checks", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let checks: ChecksHandle;
  let alice: User;
  let bob: User;
  let repo: Repo;

  async function settled(
    where: (run: Run) => boolean,
    timeoutMs = 30_000,
  ): Promise<Run> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const run = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        where,
      );
      if (run && (run.state === "ok" || run.state === "failed")) return run;
      await Bun.sleep(50);
    }
    throw new Error("check did not settle");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-checks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    promote(app.db, bob);
    const made = await createRepo(app, alice, {
      name: "lib",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });

  afterAll(async () => {
    await checks.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a commit that declares no check is not checked", async () => {
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    expect(seeded.ok).toBe(true);
    await Bun.sleep(300);
    expect(listRuns(app.db, repo.id, { kind: "check" })).toHaveLength(0);
  });

  test("the default branch is checked on push, with the log kept", async () => {
    const declared = await commitToBranch(app, alice, repo, {
      message: "Declare a check",
      files: [
        { path: "forge.json", content: checkJson("test -f OK.md") },
        { path: "OK.md", content: "ok\n" },
      ],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    const run = await settled((r) => r.commitOid === declared.value.commitOid);
    expect(run.state).toBe("ok");
    expect(run.env).toBe("main");
    expect(run.reason).toBe("push");
    expect(run.summary).toMatch(/^check passed in \d+s$/);
    const log = readRunLog(dataDir, run.id).lines.join("\n");
    expect(log).toContain("$ test -f OK.md");
  });

  test("a check's children hold no cells of their own: the check's cell is the boundary", async () => {
    // A forge the tests boot inside a check cell must not wrap its apps in
    // nested cells (they never answer in time); it is told so in its env.
    const declared = await commitToBranch(app, alice, repo, {
      message: "A check that reads its cell",
      files: [
        {
          path: "forge.json",
          content: checkJson(
            'test "$FORGE_CELLS" = off && echo "cells: $FORGE_CELLS"',
          ),
        },
      ],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    const run = await settled((r) => r.commitOid === declared.value.commitOid);
    expect(run.state).toBe("ok");
    expect(readRunLog(dataDir, run.id).lines.join("\n")).toContain(
      "cells: off",
    );
  });

  test("a pull is checked when it opens and each time its branch moves; a failure names the exit", async () => {
    // A pull is checked by the base's check, not its own.
    const gate = await commitToBranch(app, alice, repo, {
      message: "The base's check",
      files: [{ path: "forge.json", content: checkJson("test -f NOPE.md") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Leave the check failing",
      files: [{ path: "a.txt", content: "a\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    // A branch that heads no pull is nobody's to check yet.
    await Bun.sleep(300);
    expect(
      listRuns(app.db, repo.id, { kind: "check" }).some(
        (r) => r.commitOid === branched.value.commitOid,
      ),
    ).toBe(false);
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const failed = await settled(
      (r) => r.issueId === pull.id && r.commitOid === branched.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.env).toBe(`pull-${pull.number}`);
    expect(failed.reason).toBe("pull");
    expect(failed.summary).toBe("check failed: check exited with code 1");
    // `test -f` is not `bun test`: its output is not this shape, so nothing
    // is guessed at it.
    // ... but the disk's free share is recorded on every red (#5453).
    expect(failed.checkDetail?.names).toEqual([]);
    expect(typeof failed.checkDetail?.diskFree).toBe("number");
    // The check names the base tip it merged with; a default-branch push
    // merged nothing and records none (#1810).
    expect(failed.baseOid).toBe(gate.value.commitOid);
    const onMain = await settled((r) => r.commitOid === gate.value.commitOid && r.issueId === null);
    expect(onMain.baseOid).toBe("");
    const seen = checkSummary(app.db, pull.id, branched.value.commitOid);
    const line = checksLine(
      "/alice/lib",
      seen,
      false,
      true,
      false,
      "",
      "",
      0,
      "main",
    ).toString();
    const said = `checked against main at ${gate.value.commitOid.slice(0, 7)}`;
    expect(line).toContain(said);
    // The terminal says the same words (#1810).
    expect(checksText(seen, false, true, "main")).toContain(` · ${said}`);
    expect(checksText(seen, false, true)).not.toContain("checked against");
    // A green on an older base is not an unqualified pass in the terminal (#2237).
    const green = { ...seen, state: "ok" as const };
    expect(checksText(green, false, true, "main", true)).toContain(
      "checks: passed against an older main",
    );
    expect(checksText(green, false, true, "main", false)).toContain("Check passed");
    expect(checksText(green, false, true, "main", false)).not.toContain("older");
    expect(
      checksForHead(app.db, pull.id, branched.value.commitOid)[0]?.id,
    ).toBe(failed.id);

    const fixed = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Fix the check",
      files: [{ path: "NOPE.md", content: "there\n" }],
    });
    if (!fixed.ok) throw new Error(JSON.stringify(fixed.error));
    const passed = await settled(
      (r) => r.issueId === pull.id && r.commitOid === fixed.value.commitOid,
    );
    expect(passed.state).toBe("ok");
    expect(passed.reason).toBe("push");
  }, 60_000);

  test("a bun test failure in the check step is summarised: how many passed, how many failed, and their names", async () => {
    const gate = await commitToBranch(app, alice, repo, {
      message: "The base's check runs bun test",
      files: [
        { path: "forge.json", content: checkJson("bun test check.test.ts") },
      ],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branched = await commitToBranch(app, alice, repo, {
      branch: "red-tests",
      message: "Two failing tests",
      files: [
        {
          path: "check.test.ts",
          content: [
            'import { test, expect } from "bun:test";',
            'test("a passing test", () => { expect(1).toBe(1); });',
            'test("first failing test", () => { expect(1).toBe(2); });',
            'test("second failing test", () => { expect(1).toBe(2); });',
            "",
          ].join("\n"),
        },
      ],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(app, alice, repo, {
      title: "Red tests",
      baseBranch: "main",
      headBranch: "red-tests",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const failed = await settled(
      (r) => r.issueId === pull.id && r.commitOid === branched.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.checkDetail).toMatchObject({
      passed: 1,
      failed: 2,
      names: ["first failing test", "second failing test"],
    });
    expect(failed.summary).toBe(
      'check failed: 2 of 3 tests — "first failing test" and "second failing test"',
    );
  }, 30_000);

  test("a reader's fork pull is checked at the base's snapshot once a writer approves each head", async () => {
    const gate = await commitToBranch(app, alice, repo, {
      message: "The base's check passes",
      files: [{ path: "forge.json", content: checkJson("true") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const forked = await forkRepo(app, bob, repo);
    if (!forked.ok) throw new Error(String(forked.error));
    const fork = forked.value;
    const committed = await commitToBranch(app, bob, fork, {
      branch: "from-fork",
      message: "From the fork",
      files: [{ path: "FORK.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, bob, repo, {
      title: "From the fork",
      baseBranch: "main",
      headBranch: "from-fork",
      headRepo: fork,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    expect(pull.crossRepo).toBe(true);
    // Bob cannot write: nothing of his runs until Alice approves the head.
    const approved = await submitReview(app, alice, repo, pull, {
      state: "approved",
    });
    if (!approved.ok) throw new Error(String(approved.error));
    const first = await settled(
      (r) => r.issueId === pull.id && r.commitOid === committed.value.commitOid,
    );
    expect(first.state).toBe("ok");
    // The fork pushes again: the base's snapshot moves, and so does the check.
    const again = await commitToBranch(app, bob, fork, {
      branch: "from-fork",
      message: "Again",
      files: [{ path: "FORK.md", content: "hi again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    // A new head waits for its own approval.
    await Bun.sleep(300);
    expect(
      listRuns(app.db, repo.id, { kind: "check" }).some(
        (r) => r.issueId === pull.id && r.commitOid === again.value.commitOid,
      ),
    ).toBe(false);
    const reapproved = await submitReview(app, alice, repo, pull, {
      state: "approved",
    });
    if (!reapproved.ok) throw new Error(String(reapproved.error));
    const second = await settled(
      (r) => r.issueId === pull.id && r.commitOid === again.value.commitOid,
    );
    expect(second.state).toBe("ok");
  }, 60_000);

  test("approving a head whose check is already green queues no second check (#4391)", async () => {
    const based = await commitToBranch(app, alice, repo, {
      message: "The base's check passes",
      files: [{ path: "forge.json", content: checkJson("true") }],
    });
    if (!based.ok) throw new Error(JSON.stringify(based.error));
    // Bob's fork, made by the fork test above when it ran first.
    const fork =
      getRepo(app.db, "bob", repo.name) ??
      (await forkRepo(app, bob, repo).then((f) => (f.ok ? f.value : undefined)));
    if (fork === undefined) throw new Error("no fork");
    const committed = await commitToBranch(app, bob, fork, {
      branch: "green-then-approved",
      message: "Green before the second look",
      files: [{ path: "GREEN.md", content: "x\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(app, bob, repo, {
      title: "Green before the second look",
      baseBranch: "main",
      headBranch: "green-then-approved",
      headRepo: fork,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const mine = (): Run[] =>
      listRuns(app.db, repo.id, { kind: "check" }).filter(
        (r) => r.issueId === pull.id && r.commitOid === committed.value.commitOid,
      );
    // The first approval is what lets a reader's head run at all.
    const approved = await submitReview(app, alice, repo, pull, { state: "approved" });
    if (!approved.ok) throw new Error(String(approved.error));
    const first = await settled((r) => r.issueId === pull.id);
    expect(first.state).toBe("ok");
    // A second approval of the same green head on the same base is nothing new.
    const again = await submitReview(app, alice, repo, pull, {
      state: "approved",
      body: "Still good.",
    });
    if (!again.ok) throw new Error(String(again.error));
    await Bun.sleep(300);
    expect(mine().map((r) => r.id)).toEqual([first.id]);
  }, 60_000);

  test("a commit already proven green is not run again; the re-request answers with the earlier verdict (#1795)", async () => {
    const made = await commitToBranch(app, alice, repo, {
      message: "Proven once",
      files: [
        { path: "forge.json", content: checkJson("echo ran-once; test -f OK.md # proven") },
        { path: "OK.md", content: "ok\n" },
      ],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const first = await settled((r) => r.commitOid === made.value.commitOid);
    expect(first.state).toBe("ok");
    expect(readRunLog(dataDir, first.id).lines.join("\n")).toContain("ran-once");
    const asked = await checks.request(repo, "main", made.value.commitOid, "again");
    const second = await settled((r) => r.id === asked!.id);
    expect(second.state).toBe("ok");
    expect(second.summary).toBe(`already proven green by ${first.id}`);
    expect(readRunLog(dataDir, second.id).lines.join("\n")).not.toContain("ran-once");
  }, 60_000);

  test("a newer commit supersedes a check still waiting for the same environment", async () => {
    const slow = await commitToBranch(app, alice, repo, {
      message: "A slow check",
      files: [
        { path: "forge.json", content: checkJson("sleep 0.5 && test -f OK.md") },
      ],
    });
    if (!slow.ok) throw new Error(JSON.stringify(slow.error));
    // While that one holds the only slot, two more arrive: the first of
    // them is superseded by the second before it ever runs.
    const one = await checks.request(
      repo,
      "main",
      slow.value.commitOid,
      "push",
    );
    expect(one).toBeDefined();
    const two = await commitToBranch(app, alice, repo, {
      message: "Two",
      files: [{ path: "TWO.md", content: "2\n" }],
    });
    if (!two.ok) throw new Error(JSON.stringify(two.error));
    const three = await commitToBranch(app, alice, repo, {
      message: "Three",
      files: [{ path: "THREE.md", content: "3\n" }],
    });
    if (!three.ok) throw new Error(JSON.stringify(three.error));
    const last = await settled((r) => r.commitOid === three.value.commitOid);
    expect(last.state).toBe("ok");
    const middle = listRuns(app.db, repo.id, { kind: "check" }).find(
      (r) => r.commitOid === two.value.commitOid,
    );
    expect(middle?.state).toBe("cancelled");
    expect(middle?.summary).toContain("superseded by");
  }, 60_000);

  test("a new head on a pull stops its running check for the old head, superseded not failed", async () => {
    const slow = await commitToBranch(app, alice, repo, {
      branch: "supersede",
      message: "A very slow check",
      files: [
        { path: "forge.json", content: checkJson("sleep 30") },
        { path: "S.md", content: "s\n" },
      ],
    });
    if (!slow.ok) throw new Error(JSON.stringify(slow.error));
    const opened = await openPull(app, alice, repo, {
      title: "supersede",
      baseBranch: "main",
      headBranch: "supersede",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const env = `pull-${opened.value.number}`;
    const old = await checks.request(
      repo,
      env,
      slow.value.commitOid,
      "push",
      opened.value.id,
    );
    if (!old) throw new Error("no run");
    const began = Date.now();
    while (getRun(app.db, old.id)?.state !== "running") {
      if (Date.now() - began > 20_000) throw new Error("never started");
      await Bun.sleep(50);
    }
    const next = await commitToBranch(app, alice, repo, {
      branch: "supersede",
      message: "Fast",
      files: [
        { path: "forge.json", content: checkJson("test -f S.md") },
      ],
    });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    const fresh = await settled((r) => r.commitOid === next.value.commitOid);
    expect(fresh.state).toBe("ok");
    const stopped = getRun(app.db, old.id);
    expect(stopped?.state).toBe("cancelled");
    expect(stopped?.summary).toContain("superseded by");
    // Well short of the 30 s the old check would have taken.
    expect(Date.now() - began).toBeLessThan(25_000);
  }, 60_000);

  for (const ending of ["merge", "close"] as const)
    test(`${ending === "merge" ? "merging" : "closing"} a pull leaves no queued or running run for it`, async () => {
      const blocker = await commitToBranch(app, alice, repo, {
        message: "Hold the lane",
        files: [
          {
            path: "forge.json",
            content: checkJson(`sleep 0.5 && test -f OK.md # ${ending}`),
          },
        ],
      });
      if (!blocker.ok) throw new Error(JSON.stringify(blocker.error));
      await checks.request(repo, "lane", blocker.value.commitOid, "push");
      const branched = await commitToBranch(app, alice, repo, {
        branch: `lands-${ending}`,
        message: "Lands before its check runs",
        files: [{ path: "LANDS.md", content: "x\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, alice, repo, {
        title: "Lands soon",
        baseBranch: "main",
        headBranch: `lands-${ending}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = opened.value;
      const mine = (): Run[] =>
        listRuns(app.db, repo.id, { kind: "check" }).filter(
          (r) => r.issueId === pull.id,
        );
      const until = async (done: () => boolean): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!done() && Date.now() < deadline) await Bun.sleep(25);
        if (!done()) throw new Error(`never came: still waiting while !done()`);
      };
      await until(() => mine().length > 0);
      expect(mine().some((r) => r.state === "queued")).toBe(true);
      if (ending === "merge") {
        const landed = await mergePull(app, alice, repo, pull, "merge");
        if (!landed.ok) throw new Error(String(landed.error));
      } else {
        const closed = setIssueState(app, alice, repo, pull, "closed");
        if (!closed.ok) throw new Error(String(closed.error));
      }
      await until(() => mine().every((r) => r.state !== "queued"));
      expect(mine().filter((r) => r.state === "queued")).toEqual([]);
      expect(
        mine().some(
          (r) =>
            r.summary === (ending === "merge" ? "pull landed" : "pull closed"),
        ),
      ).toBe(true);
    }, 60_000);

  test("a queued gate keeps the last free slot from pull checks", () => {
    // One slot free, a gate queued: the pull check passes, the gate starts.
    expect(holdsLastSlot(1, true)).toBe(true);
    // With no gate queued the pull check takes it, as every slot.
    expect(holdsLastSlot(1, false)).toBe(false);
    // More than one free: the pull check starts, one is still left.
    expect(holdsLastSlot(2, true)).toBe(false);
  });

  test("pickNext takes the newest queued check, unless one has starved", () => {
    const a = createRun(app.db, { repoId: repo.id, kind: "check", env: "a" });
    const b = createRun(app.db, { repoId: repo.id, kind: "check", env: "b" });
    const c = createRun(app.db, { repoId: repo.id, kind: "check", env: "c" });
    // ids are creation-ordered, so this is oldest-to-newest already.
    expect(pickNext([a, b, c])?.id).toBe(c.id);
    expect(pickNext([c, a, b])?.id).toBe(c.id);
    expect(pickNext([a])?.id).toBe(a.id);
    expect(pickNext([])).toBeUndefined();

    // `a` has waited past the starvation bound: it outranks `c`, however new.
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(a.id, new Date(Date.now() - STARVATION_MS - 1_000).toISOString());
    const starved = getRun(app.db, a.id)!;
    expect(pickNext([starved, b, c])?.id).toBe(starved.id);
    // Just short of the bound, the newest still wins.
    app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(a.id, new Date(Date.now() - STARVATION_MS + 1_000).toISOString());
    expect(pickNext([getRun(app.db, a.id)!, b, c])?.id).toBe(c.id);

    // These never named a real commit: cancel them rather than leave them
    // for the live checks service running beside this test to trip over.
    for (const run of [a, b, c]) cancelRun(app.db, run.id);
  });

  test("pickNext puts an approved pull's check first, newest among them, and the starved before all", () => {
    const a = createRun(app.db, { repoId: repo.id, kind: "check", env: "a" });
    const b = createRun(app.db, { repoId: repo.id, kind: "check", env: "b" });
    const c = createRun(app.db, { repoId: repo.id, kind: "check", env: "c" });
    const now = Date.parse(c.createdAt);
    const only = (...ids: string[]) => (run: { id: string }) => ids.includes(run.id);
    // An older approved check beats a newer unapproved one.
    expect(pickNext([a, b, c], now, only(a.id))?.id).toBe(a.id);
    // Newest first among the approved.
    expect(pickNext([a, b, c], now, only(a.id, b.id))?.id).toBe(b.id);
    // With none approved, the order is unchanged.
    expect(pickNext([a, b, c], now, () => false)?.id).toBe(c.id);
    // A starved unapproved check still goes first.
    const later = now + STARVATION_MS + 1_000;
    const old = { ...a, createdAt: new Date(now - 1_000).toISOString() };
    const fresh = { ...b, createdAt: new Date(later).toISOString() };
    const approvedFresh = { ...c, createdAt: new Date(later + 1).toISOString() };
    expect(pickNext([fresh, approvedFresh, old], later, only(approvedFresh.id))?.id).toBe(old.id);
    for (const run of [a, b, c]) cancelRun(app.db, run.id);
  });

  test("when a slot frees, the newest of several queued checks runs first", async () => {
    // Three checks, on three environments so none supersedes another. Their
    // commits are written before the slot is taken: written after, on a
    // loaded machine they can outlast the holder, and the oldest then finds
    // the slot free instead of queueing.
    const oldest = await commitToBranch(app, alice, repo, {
      branch: "order-a",
      message: "A",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!oldest.ok) throw new Error(JSON.stringify(oldest.error));
    const middle = await commitToBranch(app, alice, repo, {
      branch: "order-b",
      message: "B",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!middle.ok) throw new Error(JSON.stringify(middle.error));
    const newest = await commitToBranch(app, alice, repo, {
      branch: "order-c",
      message: "C",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!newest.ok) throw new Error(JSON.stringify(newest.error));

    // A slow check on its own environment holds the only slot, and the
    // three queue behind it — oldest requested first.
    const held = await commitToBranch(app, alice, repo, {
      branch: "order-hold",
      message: "Hold the slot",
      files: [
        { path: "forge.json", content: checkJson("sleep 0.5 && test -f OK.md") },
      ],
    });
    if (!held.ok) throw new Error(JSON.stringify(held.error));
    const holder = await checks.request(
      repo,
      "order-hold",
      held.value.commitOid,
      "push",
    );
    expect(holder).toBeDefined();

    const oldestRun = await checks.request(
      repo,
      "order-a",
      oldest.value.commitOid,
      "push",
    );
    const middleRun = await checks.request(
      repo,
      "order-b",
      middle.value.commitOid,
      "push",
    );
    const newestRun = await checks.request(
      repo,
      "order-c",
      newest.value.commitOid,
      "push",
    );
    expect(oldestRun && middleRun && newestRun).toBeTruthy();
    expect(oldestRun?.state).toBe("queued");
    expect(middleRun?.state).toBe("queued");
    expect(newestRun?.state).toBe("queued");

    await settled((r) => r.id === newestRun!.id);
    await settled((r) => r.id === middleRun!.id);
    await settled((r) => r.id === oldestRun!.id);

    const runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
    const startedAt = (id: string): number =>
      Date.parse(runs.find((r) => r.id === id)!.startedAt!);
    expect(startedAt(newestRun!.id)).toBeLessThan(startedAt(middleRun!.id));
    expect(startedAt(middleRun!.id)).toBeLessThan(startedAt(oldestRun!.id));
  }, 30_000);

  test("a check in flight when the forge stops is queued again, and the next forge runs it", async () => {
    const slow = await commitToBranch(app, alice, repo, {
      message: "A slower check",
      files: [
        {
          path: "forge.json",
          // Hangs the first time it runs, passes the second: no wait to tune.
          content: checkJson(
            `if [ -f '${dataDir}/ran-once' ]; then test -f OK.md; else touch '${dataDir}/ran-once'; sleep 60; fi`,
          ),
        },
      ],
    });
    if (!slow.ok) throw new Error(JSON.stringify(slow.error));
    const oid = slow.value.commitOid;
    const deadline = Date.now() + 20_000;
    let cut: Run | undefined;
    while (Date.now() < deadline && cut?.state !== "running") {
      cut = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.commitOid === oid,
      );
      await Bun.sleep(50);
    }
    expect(cut?.state).toBe("running");

    // This forge stops — a release — with the check under way.
    await checks.stop();
    const runs = listRuns(app.db, repo.id, { kind: "check", limit: 50 });
    const interrupted = runs.find((r) => r.id === cut!.id);
    expect(interrupted?.state).toBe("cancelled");
    expect(interrupted?.summary).toContain("queued again");
    const again = runs.find((r) => r.commitOid === oid && r.state === "queued");
    expect(again?.attempt).toBe(1);

    // The forge that carries on finds it queued and runs it to the end.
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    const done = await settled((r) => r.id === again!.id);
    expect(done.state).toBe("ok");
  }, 60_000);

  async function slowCheck(command: string, message: string): Promise<string> {
    const made = await commitToBranch(app, alice, repo, {
      message,
      files: [{ path: "forge.json", content: checkJson(command) }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const oid = made.value.commitOid;
    const deadline = Date.now() + 20_000;
    let found: Run | undefined;
    while (Date.now() < deadline && found?.state !== "running") {
      found = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
        (r) => r.commitOid === oid,
      );
      await Bun.sleep(50);
    }
    expect(found?.state).toBe("running");
    return found!.id;
  }

  test("a roll waits for a running check to finish, within its budget, instead of throwing it away", async () => {
    await checks.stop();
    checks = startChecks(app, {
      forgeUrl: servers.url,
      concurrency: 1,
      drainMs: 30_000,
    });
    const id = await slowCheck("sleep 0.5 && test -f OK.md # drained", "A drained check");
    await checks.stop();
    const run = getRun(app.db, id);
    expect(run?.state).toBe("ok");
    expect(
      listRuns(app.db, repo.id, { kind: "check", limit: 50 }).some(
        (r) => r.state === "queued",
      ),
    ).toBe(false);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
  }, 60_000);

  test("a person's stop cuts a running check off at once, and queues it again", async () => {
    await checks.stop();
    checks = startChecks(app, {
      forgeUrl: servers.url,
      concurrency: 1,
      drainMs: 30_000,
    });
    const id = await slowCheck("sleep 0.5 && test -f OK.md # cut off", "A cut-off check");
    await checks.stop({ drain: false });
    const run = getRun(app.db, id);
    expect(run?.state).toBe("cancelled");
    expect(run?.summary).toContain("queued again");
    const again = listRuns(app.db, repo.id, { kind: "check", limit: 50 }).find(
      (r) => r.commitOid === run?.commitOid && r.state === "queued",
    );
    expect(again).toBeDefined();
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    const done = await settled((r) => r.id === again?.id);
    expect(done.state).toBe("ok");
  }, 60_000);

  test("a check whose pull lands while it runs ends as superseded, not failed", async () => {
    const id = await slowCheck("sleep 0.5 && false", "A check overtaken");
    cancelRun(app.db, id, "pull landed");
    const deadline = Date.now() + 20_000;
    let lines = "";
    while (Date.now() < deadline && !lines.includes("superseded")) {
      await Bun.sleep(100);
      lines = readRunLog(dataDir, id).lines.join("\n");
    }
    expect(lines).toContain("superseded: pull landed");
    expect(lines).not.toContain("failed:");
    expect(getRun(app.db, id)?.state).toBe("cancelled");
  }, 60_000);

  test("a check that is declared wrong fails with the reason", async () => {
    const wrong = await commitToBranch(app, alice, repo, {
      message: "A wrong check",
      files: [{ path: "forge.json", content: '{"check": "bun test"}\n' }],
    });
    if (!wrong.ok) throw new Error(JSON.stringify(wrong.error));
    const run = await settled((r) => r.commitOid === wrong.value.commitOid);
    expect(run.state).toBe("failed");
    expect(run.summary).toBe(
      "check failed: forge.json: check must be an object",
    );
  });
  test("an open pull whose head was never checked is checked when the service boots", async () => {
    await checks.stop();
    // The pull is checked by the base's check, so the base must ask for it.
    const gate = await commitToBranch(app, alice, repo, {
      message: "The base's check wants QUIET.md",
      files: [{ path: "forge.json", content: checkJson("test -f QUIET.md") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branch = await commitToBranch(app, alice, repo, {
      branch: "quiet",
      message: "Quiet",
      files: [{ path: "QUIET.md", content: "quiet\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    // The pull's check is the base's (#1275): give main a valid one.
    const base = await commitToBranch(app, alice, repo, {
      branch: "main",
      message: "The base's check",
      files: [{ path: "forge.json", content: checkJson("test -f QUIET.md") }],
    });
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    // Opened while no checks service was listening: nothing asked for a check.
    const opened = await openPull(app, alice, repo, {
      title: "Quiet",
      baseBranch: "main",
      headBranch: "quiet",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(
      listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter(
        (r) => r.commitOid === opened.value.headOid,
      ),
    ).toHaveLength(0);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    const done = await settled((r) => r.commitOid === opened.value.headOid);
    expect(done.reason).toBe("boot");
    expect(done.state).toBe("ok");
  }, 60_000);
});

describe("a check its forge died under", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  let pull: Pull;
  let stale: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-checks-abandoned-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "lib" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const first = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "First",
      files: [{ path: "A.md", content: "a\n" }],
    });
    if (!first.ok) throw new Error(JSON.stringify(first.error));
    stale = first.value.commitOid;
    const second = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Second",
      files: [{ path: "B.md", content: "b\n" }],
    });
    if (!second.ok) throw new Error(JSON.stringify(second.error));
    const opened = await openPull(app, alice, repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    pull = opened.value;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A check that was running when its forge died: claimed, lease long lapsed. */
  const abandoned = (commitOid: string, attempt = 0): Run => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: `pull-${pull.number}`,
      commitOid,
      reason: "push",
      issueId: pull.id,
      attempt,
    });
    claimRun(app.db, run.id);
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(run.id, new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString());
    return getRun(app.db, run.id)!;
  };

  const word = () =>
    pullWord(
      {
        db: app.db,
        dir: repoDir(app.reposRoot, repo.ownerName, repo.name),
        runtime: undefined,
        record: undefined,
        history: servingHistory(),
        viewer: undefined,
      },
      pull,
    );

  const queuedFor = (commitOid: string): Run[] =>
    listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter(
      (r) => r.commitOid === commitOid && r.state === "queued",
    );

  test("a check for the head of an open pull is queued again, attempt + 1, and the change reads working", async () => {
    const run = abandoned(pull.headOid);
    expect((await word()).word).toBe("working");
    expect(requeueAbandonedChecks(app, STALE_AFTER_MS)).toBe(1);
    // A second forge sweeping the same lapse finds nothing left to move.
    expect(requeueAbandonedChecks(app, STALE_AFTER_MS)).toBe(0);
    const cut = getRun(app.db, run.id)!;
    expect(cut.state).toBe("cancelled");
    expect(cut.summary).toBe(REQUEUED_SUMMARY);
    const again = queuedFor(pull.headOid);
    expect(again).toHaveLength(1);
    expect(again[0]!.attempt).toBe(1);
    expect(again[0]!.issueId).toBe(pull.id);
    expect(again[0]!.env).toBe(`pull-${pull.number}`);
    expect(await word()).toEqual({ word: "working", note: "queued to check" });
    cancelRun(app.db, again[0]!.id);
  });

  test("a check whose lease is still held is left alone", () => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      issueId: pull.id,
    });
    claimRun(app.db, run.id);
    expect(requeueAbandonedChecks(app, STALE_AFTER_MS)).toBe(0);
    expect(getRun(app.db, run.id)?.state).toBe("running");
    cancelRun(app.db, run.id);
  });

  test("at the ceiling the check fails once, saying the forge kept going away", async () => {
    const run = abandoned(pull.headOid, CHECK_RESTART_LIMIT);
    expect(requeueAbandonedChecks(app, STALE_AFTER_MS)).toBe(1);
    const failed = getRun(app.db, run.id)!;
    expect(failed.state).toBe("failed");
    expect(failed.summary).toContain(
      "the forge kept going away under this check",
    );
    expect(queuedFor(pull.headOid)).toHaveLength(0);
    expect((await word()).word).toBe("stopped");
  });

  test("a check for a commit that no longer heads an open pull is cancelled, not queued again", () => {
    const run = abandoned(stale);
    expect(requeueAbandonedChecks(app, STALE_AFTER_MS)).toBe(1);
    const cut = getRun(app.db, run.id)!;
    expect(cut.state).toBe("cancelled");
    expect(cut.summary).toContain("no longer heads an open pull");
    expect(queuedFor(stale)).toHaveLength(0);
  });
});

describe("startChecks: a booting forge removes only checkouts nobody is running (#1884)", () => {
  test("a live run's checkout survives, a lapsed run's and a stranger's go", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-sweep-"));
    const db = createApp({ dataDir: dir, port: 0 });
    try {
      const u = await createUser(db.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(db, u.value, { name: "lib" });
      if (!made.ok) throw new Error(String(made.error));
      const mk = (): Run => {
        const run = createRun(db.db, { repoId: made.value.id, kind: "check", env: "x" });
        claimRun(db.db, run.id);
        return run;
      };
      const live = mk();
      const lapsed = mk();
      db.db
        .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
        .run(lapsed.id, new Date(Date.now() - STALE_AFTER_MS - 5_000).toISOString());
      const where = (id: string): string => join(dir, "checks", id);
      for (const id of [live.id, lapsed.id, "no-such-run"])
        mkdirSync(where(id), { recursive: true });
      const handle = startChecks(db, { forgeUrl: "http://localhost" });
      await sweepSoon(db);
      await handle.stop();
      expect(existsSync(where(live.id))).toBe(true);
      expect(existsSync(where(lapsed.id))).toBe(false);
      expect(existsSync(where("no-such-run"))).toBe(false);
    } finally {
      db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("checks: a finished shard is announced as the runner writes it (#2889)", () => {
  test("each shard-done line the check prints puts one run.shard on the bus, and nothing else does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-shards-"));
    const shardApp = createApp({ dataDir: dir, port: 0 });
    const shardServers = await serve(shardApp);
    const handle = startChecks(shardApp, { forgeUrl: shardServers.url, concurrency: 1 });
    try {
      const u = await createUser(shardApp.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(shardApp, u.value, { name: "lib", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const lines = [
        "test-shards: 3 files in 2 shards",
        "── shard 1/2: a.ts b.ts",
        " 5 pass",
        "── shard 1/2 done (exit 0, 1.0s)",
        "── shard 2/2: c.ts",
        "── shard 2/2 done (exit 0, 1.0s)",
      ];
      const script = lines.map((l) => `echo '${l}'`).join("; ");
      const pushed = await commitToBranch(shardApp, u.value, made.value, {
        message: "Declare a check",
        files: [{ path: "forge.json", content: checkJson(script) }],
      });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const deadline = Date.now() + 30_000;
      let run: Run | undefined;
      while (Date.now() < deadline) {
        run = listRuns(shardApp.db, made.value.id, { kind: "check", limit: 5 })[0];
        if (run && (run.state === "ok" || run.state === "failed")) break;
        await Bun.sleep(50);
      }
      expect(run?.state).toBe("ok");
      const shards = listEvents(shardApp.db, { repoId: made.value.id, kind: "run.shard" });
      expect(shards.map((e) => e.payload["shard"]).sort()).toEqual([1, 2]);
      expect(shards.every((e) => e.payload["runId"] === run!.id && e.payload["of"] === 2)).toBe(true);
    } finally {
      await handle.stop();
      shardServers.stop();
      shardApp.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
