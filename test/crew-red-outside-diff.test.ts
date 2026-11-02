/**
 * A pull red only on a test its diff does not reach gets one fresh re-check
 * before a try is spent on it (#7630). Through the crew's event path, with
 * the impact map kept for the repository and a decider that always says
 * stop (which no longer parks: one red goes back to its builder): a red
 * outside the diff is checked once more on the same head, and the re-check
 * says so in its log; green then, the decider is never asked and no rework
 * is queued; red again, it is, and the builder reworks it. A red inside
 * the diff goes to the decider and the builder at once. Each red names its
 * own test, so no two pulls share one more than twice in the hour
 * (`shared_red.ts`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { formatImpact } from "../src/checks/impact.ts";
import { IMPACT_FILE, keepImpact } from "../src/checks/impact-store.ts";
import { OUTSIDE_DIFF, recheckLine, redOutsideDiff } from "../src/checks/outside_diff.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import type { Decider } from "../src/crew/decide.ts";
import { appendRunLog, readRunLog } from "../src/runs/log.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

const IMPACT = new Map([
  ["test/people.test.ts", ["src/people.ts"]],
  ["test/feature.test.ts", ["src/feature.ts", "src/shared.ts"]],
  ["test/flake.test.ts", ["src/shared.ts"]],
]);

describe("which reds are outside the diff", () => {
  test("a mapped test that executes none of the changed files", () => {
    expect(redOutsideDiff(["test/people.test.ts"], ["src/feature.ts"], IMPACT)).toEqual(["test/people.test.ts"]);
  });
  test("any failing test the diff reaches, changes, or the map has not measured is the pull's", () => {
    expect(redOutsideDiff(["test/people.test.ts", "test/feature.test.ts"], ["src/feature.ts"], IMPACT)).toBeUndefined();
    expect(redOutsideDiff(["test/people.test.ts"], ["src/feature.ts", "test/people.test.ts"], IMPACT)).toBeUndefined();
    expect(redOutsideDiff(["test/new.test.ts"], ["src/feature.ts"], IMPACT)).toBeUndefined();
  });
  test("a diff the map cannot bound, a changed helper, or a repo-wide rule test is the pull's", () => {
    for (const unbounded of ["package.json", "bun.lock", "scripts/gate.ts", "test/helpers/x.ts"])
      expect(redOutsideDiff(["test/people.test.ts"], ["src/feature.ts", unbounded], IMPACT)).toBeUndefined();
    expect(redOutsideDiff(["test/flake.test.ts"], ["src/feature.ts"], IMPACT)).toBeUndefined();
    expect(redOutsideDiff([], ["src/feature.ts"], IMPACT)).toBeUndefined();
  });
});

describe("the crew, with a red outside the diff", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let asked: string[] = [];
  let n = 0;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
    standIn.checks.request = async (...args: unknown[]) => {
      const [r, env, commitOid, reason, issueId] = args as [Repo, string, string, string, string];
      return createRun(app.db, { repoId: r.id, kind: "check", env, commitOid, reason, issueId });
    };
    const decider: Decider = {
      name: "stand-in",
      async decide(state) {
        asked.push(String((state as { pull?: { number: number } }).pull?.number));
        return {
          retry: { choice: "stop", p: 1, probabilities: { again: 0, stop: 1 } },
          cause: { choice: "change", p: 1, probabilities: { change: 1, environment: 0, base: 0 } },
        } as never;
      },
    };
    (app.config as { decider?: Decider }).decider = decider;
    // Parking is autonomy's: the repository runs on its own, on alice's word.
    app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2", [alice.id, repo.id]);
    const checkout = mkdtempSync(join(tmpdir(), "forge-outside-diff-"));
    writeFileSync(join(checkout, IMPACT_FILE), formatImpact(IMPACT));
    expect(keepImpact(app.config.dataDir, repo.id, checkout)).toBe("impact map kept: 3 tests");
    rmSync(checkout, { recursive: true, force: true });
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  /** The crew's pull changing src/feature.ts. */
  const featurePull = async (): Promise<Pull> => {
    const branch = `feat-${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      message: branch,
      branch,
      files: [{ path: "src/feature.ts", content: `export const n = ${n};\n` }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, bot, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    return getPull(app.db, repo.id, o.value.number)!;
  };
  /** A check run on the pull's head, finished and announced; its log names `file` red. */
  const finish = (run: Run, state: "ok" | "failed", file = "test/people.test.ts"): void => {
    claimRun(app.db, run.id);
    if (state === "failed") {
      appendRunLog(app.config.dataDir, run.id, `${file}:`);
      appendRunLog(app.config.dataDir, run.id, `(fail) ${file} > verify [3.00ms]`);
    }
    const done = finishRun(app.db, run.id, {
      state,
      summary: state === "ok" ? "check passed" : "check failed",
      ...(state === "failed" ? { checkDetail: { passed: 9, failed: 1, names: [`${file} > verify`] } } : {}),
    })!;
    announceRun(app, done);
  };
  const pushRed = (pull: Pull, file?: string): void =>
    finish(
      createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${pull.number}`, commitOid: pull.headOid, reason: "push", issueId: pull.id }),
      "failed",
      file,
    );
  const rechecks = (pull: Pull): Run[] =>
    listRuns(app.db, repo.id, { kind: "check", limit: 50 }).filter((r) => r.issueId === pull.id && r.reason === OUTSIDE_DIFF);
  const open = (pull: Pull): boolean => getIssueById(app.db, pull.id)?.state === "open";
  /** The builder's tries spent on the pull's reds. */
  const reworks = (pull: Pull): number =>
    listRuns(app.db, repo.id, { kind: "agent", limit: 50 }).filter((r) => r.issueId === pull.id && r.reason === "check_failed").length;
  const until = async (done: () => boolean): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!done() && Date.now() < deadline) await Bun.sleep(20);
    expect(done()).toBe(true);
  };

  test("red outside the diff: one re-check on the same head, which says why; green, no try is spent", async () => {
    asked = [];
    const pull = await featurePull();
    pushRed(pull);
    await until(() => rechecks(pull).length === 1);
    const recheck = rechecks(pull)[0]!;
    expect(recheck.commitOid).toBe(pull.headOid);
    expect(readRunLog(app.config.dataDir, recheck.id).lines).toContain(recheckLine(["test/people.test.ts"]));
    expect(recheckLine(["test/people.test.ts"])).toBe("re-checked: red outside the diff (test/people.test.ts)");
    finish(recheck, "ok");
    await Bun.sleep(100);
    expect(asked).toEqual([]);
    expect(reworks(pull)).toBe(0);
    expect(open(pull)).toBe(true);
    expect(rechecks(pull)).toHaveLength(1);
  });

  test("red outside the diff twice: the second red is the builder's, one try spent, never parked", async () => {
    asked = [];
    const pull = await featurePull();
    pushRed(pull);
    await until(() => rechecks(pull).length === 1);
    expect(asked).toEqual([]);
    expect(reworks(pull)).toBe(0);
    finish(rechecks(pull)[0]!, "failed");
    await until(() => reworks(pull) === 1);
    expect(asked).toEqual([String(pull.number)]);
    expect(open(pull)).toBe(true);
    expect(rechecks(pull)).toHaveLength(1);
  });

  test("red inside the diff: no re-check, the builder's at once", async () => {
    asked = [];
    const pull = await featurePull();
    pushRed(pull, "test/feature.test.ts");
    await until(() => reworks(pull) === 1);
    expect(asked).toEqual([String(pull.number)]);
    expect(open(pull)).toBe(true);
    expect(rechecks(pull)).toEqual([]);
  });
});
