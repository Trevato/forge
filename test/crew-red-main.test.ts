/**
 * A red that main shares never parks a pull (#1971): through the crew's
 * event path, a pull whose check fails only what main fails is not reworked
 * or struck, waits, and is checked again (once, at the same head) when
 * main's check passes. The stand-in forge is `helpers/crew-standin.ts`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("the crew, with a red main it shares", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let requested: unknown[][] = [];
  let n = 0;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
    // The checks handle is a plain object: record what the crew asks of it.
    standIn.checks.request = async (...args: unknown[]) => {
      requested.push(args);
      return undefined;
    };
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  const pullOf = async (): Promise<Pull> => {
    const branch = `feat-${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      message: branch,
      branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    return getPull(app.db, repo.id, o.value.number)!;
  };
  const finish = (env: string, state: "ok" | "failed", names: string[], pull?: Pull) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env,
      commitOid: pull?.headOid ?? "a".repeat(40),
      reason: "push",
      ...(pull === undefined ? {} : { issueId: pull.id }),
    });
    claimRun(app.db, run.id);
    const done = finishRun(app.db, run.id, {
      state,
      summary: state === "ok" ? "check passed" : "check failed",
      ...(state === "failed" ? { checkDetail: { passed: 1, failed: names.length, names } } : {}),
    })!;
    announceRun(app, done);
    return done;
  };
  const reworks = (pull: Pull) =>
    listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.issueId === pull.id && r.reason === "check_failed");

  test("a main check's finished event is a check with no pull", () => {
    const run = finish("main", "failed", ["X"]);
    expect(run.issueId).toBeNull();
    expect(run.kind).toBe("check");
  });

  test("shared red: no rework; an own red is reworked as ever; main failing again keeps the wait", async () => {
    finish("main", "failed", ["X"]);
    const shared = await pullOf();
    const own = await pullOf();
    finish(`pull-${shared.number}`, "failed", ["X"], shared);
    finish(`pull-${own.number}`, "failed", ["X", "Y"], own);
    expect(reworks(shared)).toHaveLength(0);
    expect(reworks(own)).toHaveLength(1);
    // Still red: nothing is checked again, the pull still waits.
    requested = [];
    finish("main", "failed", ["X"]);
    expect(requested).toHaveLength(0);
    // Green: the waiting pull, not the reworked one, is checked again, once.
    finish("main", "ok", []);
    expect(requested).toEqual([[repo, `pull-${shared.number}`, shared.headOid, "retry", shared.id]]);
    finish("main", "ok", []);
    expect(requested).toHaveLength(1);
  });

  test("a pull pushed, closed or merged meanwhile is not checked again", async () => {
    finish("main", "failed", ["X"]);
    const pushed = await pullOf();
    const closed = await pullOf();
    const merged = await pullOf();
    const kept = await pullOf();
    for (const p of [pushed, closed, merged, kept]) finish(`pull-${p.number}`, "failed", ["X"], p);
    app.db.run("UPDATE pull SET head_oid = ?1 WHERE issue_id = ?2", ["b".repeat(40), pushed.id]);
    app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?1", [closed.id]);
    app.db.run("UPDATE issue SET state = 'closed' WHERE id = ?1", [merged.id]);
    for (const p of [pushed, closed, merged, kept]) expect(reworks(p)).toHaveLength(0);
    requested = [];
    finish("main", "ok", []);
    expect(requested.map((r) => r[4])).toEqual([kept.id]);
  });
});
