/**
 * A failed check or deploy never closes a pull while its builder's run is
 * queued or running (#6575): nothing is decided then, and the failure is
 * decided again when the run ends.
 */

import { pullCloses } from "./helpers/pull-closes.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, getRun, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("a failure during the builder's run", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let n = 0;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
    standIn.checks.request = async () => undefined;
    app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2", [alice.id, repo.id]);
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  /** A pull whose automatic tries are spent, so a failure parks it. */
  const spentPull = async (body?: string): Promise<Pull> => {
    const branch = `busy-${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      message: branch,
      branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, bot, repo, { title: branch, baseBranch: "main", headBranch: branch, ...(body === undefined ? {} : { body }) });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: o.value.id, reason: "check_failed" });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "ok", summary: "reworked" });
    }
    return getPull(app.db, repo.id, o.value.number)!;
  };
  const failure = (pull: Pull, kind: "check" | "deploy"): Run => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "push",
      issueId: pull.id,
    });
    claimRun(app.db, run.id);
    return finishRun(app.db, run.id, { state: "failed", summary: `${kind} failed` })!;
  };
  const open = (pull: Pull) => getIssueById(app.db, pull.id)?.state === "open";
  const closes = (pull: Pull) => pullCloses(app, pull);

  const building = (issueId: string): Run => {
    const run = createRun(app.db, { repoId: repo.id, kind: "agent", issueId, reason: "feedback" });
    claimRun(app.db, run.id);
    return run;
  };
  const ends = (run: Run): void =>
    announceRun(app, finishRun(app.db, run.id, { state: "ok", summary: "pushed nothing" })!);
  const push = async (pull: Pull): Promise<void> => {
    const c = await commitToBranch(app, alice, repo, {
      message: "more",
      branch: pull.headBranch,
      files: [{ path: `more-${++n}.md`, content: "y\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };

  test("a failed deploy during a running build leaves the pull open, and it is decided when the run ends", async () => {
    const pull = await spentPull();
    const run = building(pull.id);
    announceRun(app, failure(pull, "deploy"));
    expect(open(pull)).toBe(true);
    ends(run);
    await closes(pull);
  });

  test("a queued run holds it too, and the end of that run decides it", async () => {
    const pull = await spentPull();
    const queued = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, reason: "feedback" });
    announceRun(app, failure(pull, "check"));
    expect(open(pull)).toBe(true);
    claimRun(app.db, queued.id);
    ends(queued);
    await closes(pull);
  });

  test("a run on the issue the pull closes holds it as well", async () => {
    const source = openIssue(app, alice, repo, { title: "source" });
    if (!source.ok) throw new Error(String(source.error));
    const pull = await spentPull(`Closes #${source.value.number}`);
    const run = building(source.value.id);
    announceRun(app, failure(pull, "deploy"));
    expect(open(pull)).toBe(true);
    ends(run);
    await closes(pull);
  });

  test("a push during the run makes the failure history: the run's end decides nothing", async () => {
    const pull = await spentPull();
    const run = building(pull.id);
    announceRun(app, failure(pull, "check"));
    await push(pull);
    ends(run);
    expect(open(pull)).toBe(true);
  });

  test("a pull closed during the run forgets the failure; reopened, it is not parked by it", async () => {
    const pull = await spentPull();
    const run = building(pull.id);
    announceRun(app, failure(pull, "check"));
    const issue = getIssueById(app.db, pull.id)!;
    expect(setIssueState(app, alice, repo, issue, "closed").ok).toBe(true);
    // Closing the pull cancels the run, which announces its end.
    expect(getRun(app.db, run.id)?.state).not.toBe("running");
    expect(setIssueState(app, alice, repo, getIssueById(app.db, pull.id)!, "open").ok).toBe(true);
    ends(building(pull.id));
    expect(open(pull)).toBe(true);
  });

  test("the same failure after the run ended closes it as before", async () => {
    const pull = await spentPull();
    announceRun(app, failure(pull, "deploy"));
    await closes(pull);
  });
});
