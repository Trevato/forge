/**
 * Verify after landing (#7786): main's whole suite runs on a schedule with
 * `--impact`, a red that stays red alone is bisected to the landing that
 * broke it, which gets one revert pull (or, landed by no pull, one issue),
 * and /boards' Pipeline says how long main has gone unverified.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { parseCheck } from "../src/apps/manifest.ts";
import { afterVerify } from "../src/checks/culprit.ts";
import {
  BISECT_ENV,
  BISECT_PREFIX,
  bisectOrigin,
  FLAKY_ALONE,
  failedFiles,
  maxSteps,
  nextStep,
  onlyEnv,
  onlyFiles,
  safeFile,
  VERIFY_ENV,
  VERIFY_EVERY_MS,
  verifyDue,
} from "../src/checks/verify.ts";
import { listPulls, getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun, getRun, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readVerified, spanWords, verifiedSays } from "../src/flow/verified.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { flowPanel } from "../src/web/pages/flow-panel.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { flowFor } from "../src/system/telemetry.ts";

describe("when a verification is due", () => {
  const at = Date.parse("2026-11-01T12:00:00Z");
  const base = { tip: "b", active: false, now: at, everyMs: VERIFY_EVERY_MS };
  test("never verified: now", () => expect(verifyDue(base)).toBe(true));
  test("main has not moved: not again", () =>
    expect(verifyDue({ ...base, last: { commitOid: "b", createdAt: "2026-11-01T00:00:00Z" } })).toBe(false));
  test("moved, 29 minutes after the last: not yet; 30: now", () => {
    expect(verifyDue({ ...base, last: { commitOid: "a", createdAt: "2026-11-01T11:31:00Z" } })).toBe(false);
    expect(verifyDue({ ...base, last: { commitOid: "a", createdAt: "2026-11-01T11:30:00Z" } })).toBe(true);
  });
  test("one already queued or running: never a second", () => expect(verifyDue({ ...base, active: true })).toBe(false));
  test("every 30 minutes at most", () => expect(VERIFY_EVERY_MS).toBe(1_800_000));
});

describe("bisecting a range", () => {
  // Eight commits after the green; c3 broke it. ⌈log₂ 8⌉ = 3 steps at most.
  const range = ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"];
  const broken = (c: string): boolean => range.indexOf(c) >= 3;

  test("walks to the culprit in at most ⌈log₂ n⌉ steps, each a commit inside the range", () => {
    const tried = new Map<string, boolean>();
    let step = nextStep(range, tried);
    while (step?.kind === "test") {
      expect(range.slice(0, -1)).toContain(step.commit);
      tried.set(step.commit, !broken(step.commit));
      step = nextStep(range, tried);
    }
    expect(step).toEqual({ kind: "culprit", commit: "c3" });
    expect(tried.size).toBeLessThanOrEqual(maxSteps(range.length));
    expect(maxSteps(8)).toBe(3);
  });

  test("by hand: the first step is the middle, c3; red there, then c1; green, then c2; green: c3", () => {
    const tried = new Map<string, boolean>();
    expect(nextStep(range, tried)).toEqual({ kind: "test", commit: "c3" });
    tried.set("c3", false);
    expect(nextStep(range, tried)).toEqual({ kind: "test", commit: "c1" });
    tried.set("c1", true);
    expect(nextStep(range, tried)).toEqual({ kind: "test", commit: "c2" });
    tried.set("c2", true);
    expect(nextStep(range, tried)).toEqual({ kind: "culprit", commit: "c3" });
  });

  test("one commit since the green is the culprit at once", () =>
    expect(nextStep(["c0"], new Map())).toEqual({ kind: "culprit", commit: "c0" }));

  test("the culprit is the newest when every step is green", () => {
    const tried = new Map([["c0", true], ["c1", true]]);
    expect(nextStep(["c0", "c1", "c2"], tried)).toEqual({ kind: "culprit", commit: "c2" });
  });

  test("a step's reason names its red verification, and nothing else is read as one", () => {
    expect(bisectOrigin(`${BISECT_PREFIX}01abc`)).toBe("01abc");
    expect(bisectOrigin("bisect:../x")).toBeUndefined();
    expect(bisectOrigin("schedule")).toBeUndefined();
  });
});

describe("the files a red names", () => {
  const log = [
    "test/a.test.ts:",
    "(pass) a > one",
    "test/b.test.ts:",
    "(fail) b > two",
    "(fail) b > three",
    "test/c.test.ts:",
    "(fail) c > four",
    "-rf.test.ts:",
    "(fail) flag",
    "test/d.test.ts:",
    "(fail) d > flaky",
    `test-shards: ${FLAKY_ALONE} ./test/d.test.ts`,
  ];
  test("each failing file once, in order; one green alone is not one; a flag-like path is dropped", () =>
    expect(failedFiles(log)).toEqual(["test/b.test.ts", "test/c.test.ts"]));
  test("a path that reads as a flag, climbs out, or carries a shell word is not a test file to run", () => {
    for (const bad of ["-x.test.ts", "--preload=x.test.ts", "../a.test.ts", "test/../../a.test.ts", "a b.test.ts", "a;rm.test.ts", "$(x).test.ts", ""])
      expect(safeFile(bad)).toBe(false);
    expect(safeFile("test/a-b.test.ts")).toBe(true);
    expect(failedFiles(["-rf.test.ts:", "(fail) x"])).toEqual([]);
  });
  test("FORGE_CHECK_ONLY carries only safe paths", () => {
    expect(onlyEnv(["test/a.test.ts", "../etc/passwd", "-x.test.ts"])).toBe("test/a.test.ts");
    expect(onlyFiles("test/a.test.ts, ../b.test.ts,,test/c.test.ts")).toEqual(["test/a.test.ts", "test/c.test.ts"]);
    expect(onlyFiles(undefined)).toBeUndefined();
  });
});

describe("the forge's own forge.json verifies main", () => {
  const forgeJson = readFileSync(join(import.meta.dir, "..", "forge.json"), "utf8");
  test("check.verify runs the whole gate with --impact, without stopping at the first red, at low priority", () => {
    const parsed = parseCheck(forgeJson, undefined);
    if (!parsed.ok || parsed.value === undefined) throw new Error("forge.json has no check");
    const verify = parsed.value.verify ?? "";
    for (const flag of ["--gate", "--impact", "--keep-going", "--nice"]) expect(verify).toContain(flag);
  });
  test("a check that does not say how verifies nothing", () => {
    const parsed = parseCheck(JSON.stringify({ check: { run: "bun test" } }), undefined);
    expect(parsed.ok && parsed.value?.verify).toBeNull();
  });
});

describe("a red verification names its culprit", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const FILE = "test/thing.test.ts";

  const tip = async (): Promise<string> =>
    (await resolveOid(repoDir(app.reposRoot, repo.ownerName, repo.name), "refs/heads/main")) ?? "";

  const land = async (branch: string): Promise<Pull> => {
    await commitToBranch(app, alice, repo, {
      branch,
      base: "main",
      message: branch,
      files: [{ path: `${branch}.txt`, content: `${branch}\n` }],
    });
    const opened = await openPull(app, alice, repo, { title: `Change ${branch}`, baseBranch: "main", headBranch: branch });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const merged = await mergePull(app, alice, repo, opened.value, "squash");
    if (!merged.ok) throw new Error(JSON.stringify(merged.error));
    return getPull(app.db, repo.id, opened.value.number)!;
  };

  const finish = (run: Run, state: "ok" | "failed"): Run => {
    app.db
      .query("UPDATE run SET state = ?2, check_detail = ?3, finished_at = ?4 WHERE id = ?1")
      .run(
        run.id,
        state,
        state === "ok" ? "" : JSON.stringify({ passed: 0, failed: 1, names: ["thing > works"], files: [FILE] }),
        new Date().toISOString(),
      );
    return getRun(app.db, run.id)!;
  };

  const verification = async (state: "ok" | "failed"): Promise<Run> =>
    finish(createRun(app.db, { repoId: repo.id, kind: "check", env: VERIFY_ENV, commitOid: await tip(), reason: "schedule" }), state);

  /** Runs the bisection to its end; a step is red at and after `culprit`. */
  const bisect = async (red: Run, culprit: string, order: readonly string[]): Promise<{ lines: string[]; steps: number }> => {
    const lines: string[] = [];
    let steps = 0;
    let asked: Run | undefined;
    const ask = async (_r: Repo, env: string, commitOid: string, reason: string): Promise<Run | undefined> => {
      asked = createRun(app.db, { repoId: repo.id, kind: "check", env, commitOid, reason });
      return asked;
    };
    let next: Run = red;
    for (let i = 0; i < 10; i++) {
      asked = undefined;
      lines.push(...(await afterVerify(app, repo, next, ask)));
      if (asked === undefined) break;
      const step: Run = asked;
      expect(step.env).toBe(BISECT_ENV);
      steps++;
      next = finish(step, order.indexOf(step.commitOid) >= order.indexOf(culprit) ? "failed" : "ok");
    }
    return { lines, steps };
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-verify-"));
    app = createApp({ dataDir, port: 0 });
    const created = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!created.ok) throw new Error(created.error);
    alice = created.value;
    const made = await createRepo(app, alice, { name: "app", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, { branch: "main", message: "base", files: [{ path: "a.txt", content: "a\n" }] });
  });

  afterEach(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("four landings since the green: the third is named in two steps, and its revert is proposed once", async () => {
    await verification("ok");
    const pulls: Pull[] = [];
    const oids: string[] = [];
    for (const b of ["one", "two", "three", "four"]) {
      pulls.push(await land(b));
      oids.push(await tip());
    }
    const red = await verification("failed");
    const { lines, steps } = await bisect(red, oids[2]!, oids);
    expect(steps).toBeLessThanOrEqual(maxSteps(4));
    expect(lines.at(-1)).toContain(`culprit #${pulls[2]!.number}`);
    const reverts = listPulls(app.db, repo.id, { state: "all" }).filter((p) => p.revertsPullId !== null);
    expect(reverts.map((p) => p.revertsPullId)).toEqual([pulls[2]!.id]);
    expect(reverts[0]!.body).toContain(FILE);
    expect(reverts[0]!.body).toContain("thing > works");
    expect(reverts[0]!.mergedAt).toBeNull();
    // The same red asked again proposes nothing more.
    expect((await afterVerify(app, repo, red, async () => undefined))[0]).toContain("already proposed");
    expect(listPulls(app.db, repo.id, { state: "all" }).filter((p) => p.revertsPullId !== null)).toHaveLength(1);
  });

  test("a push no pull carried is named in one issue", async () => {
    await verification("ok");
    await commitToBranch(app, alice, repo, { branch: "main", message: "direct", files: [{ path: "b.txt", content: "b\n" }] });
    const red = await verification("failed");
    const lines = await afterVerify(app, repo, red, async () => undefined);
    expect(lines[0]).toContain("landed by no pull");
    const issues = app.db
      .query<{ title: string; body: string }, [string]>("SELECT title, body FROM issue WHERE repo_id = ?1 AND kind = 'issue'")
      .all(repo.id);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.body).toContain(FILE);
    // A second red of the same thing files nothing new.
    await afterVerify(app, repo, red, async () => undefined);
    expect(app.db.query("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue'").get(repo.id)).toEqual({ n: 1 });
  });

  test("a red whose files were already red at the verification before starts nothing", async () => {
    await verification("ok");
    await land("one");
    await verification("failed");
    await land("two");
    const again = await verification("failed");
    let asked = 0;
    const lines = await afterVerify(app, repo, again, async () => {
      asked++;
      return undefined;
    });
    expect(asked).toBe(0);
    expect(lines[0]).toContain("already failed");
  });

  test("/boards says how long main has gone unverified, and a reader who cannot see a private repository does not", async () => {
    createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: await tip() });
    const green = await verification("ok");
    expect(verifiedSays(readVerified(app, true)[0]!, Date.now())).toContain("main verified at");
    await land("one");
    // The forge checks main's push of every landing; that check is when it landed.
    createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: await tip() });
    const row = readVerified(app, true)[0]!;
    expect(row.green?.runId).toBe(green.id);
    expect(row.unverifiedSince).not.toBeNull();
    const since = Date.parse(row.unverifiedSince!);
    expect(verifiedSays(row, since + 45 * 60_000)).toContain("main unverified for 45 min");
    expect(verifiedSays(row, since + 150 * 60_000)).toContain("main unverified for 2.5 h");
    const page = String(flowPanel(app, { kind: "owner" }, new URL("http://x/boards"), "/boards"));
    expect(page).toContain('id="verified"');
    expect(page).toContain(`data-verified="alice/app"`);
    expect(page).toContain("main unverified for");
    // The API's and the MCP flow tool's reading says the same.
    // The terminal's Flow dialog says the same line, for the same reader.
    const said = (rows: ReturnType<typeof readVerified>): string =>
      flowLines(app.db, new Date(), undefined, undefined, undefined, null, rows).join("\n");
    expect(said(readVerified(app, true))).toContain("alice/app: main unverified for");
    expect(flowFor(app, { kind: "owner" }).verified[0]?.says).toContain("main unverified for");
    app.db.run("UPDATE repo SET visibility = 'private' WHERE id = ?1", [repo.id]);
    expect(readVerified(app, false)).toEqual([]);
    expect(flowFor(app, { kind: "agent" }).verified).toEqual([]);
    expect(said(readVerified(app, false))).not.toContain("alice/app: main");
    expect(String(flowPanel(app, { kind: "agent" }, new URL("http://x/boards"), "/boards"))).not.toContain('data-verified="alice/app"');
  });

  test("spans read in minutes under an hour and hours after", () => {
    expect(spanWords(7 * 60_000 + 59_000)).toBe("7 min");
    expect(spanWords(3_600_000)).toBe("1.0 h");
  });
});
