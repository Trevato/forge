/**
 * A red many pulls share never parks them (#2266): through the crew's event
 * path, with main green, three pulls whose checks fail one test in the hour
 * — a test a re-run passed — are neither parked nor reworked and are checked
 * again on main's next green check; a pull red on a test only it fails is
 * parked as ever, and so is each of many pulls red on a test main passes and
 * no re-run passed (#8786). Each pull has
 * already spent its automatic tries, so any red that is its own parks it.
 */

import { pullCloses } from "./helpers/pull-closes.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun, type Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { ErrorLedger } from "../src/kernel/log.ts";
import { RefusedLedger } from "../src/kernel/internal_refused.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("the crew, with a red many pulls share", () => {
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
    standIn.checks.request = async (...args: unknown[]) => {
      requested.push(args);
      return undefined;
    };
    // Parking is autonomy's: the repository runs on its own, on alice's word.
    app.db.run("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?1 WHERE id = ?2", [alice.id, repo.id]);
  }, 30_000);
  afterAll(() => stopStandInCrew(standIn));

  /** A pull of the crew's whose automatic tries are spent: its own next red parks it. */
  const spentPull = async (): Promise<Pull> => {
    const branch = `feat-${++n}`;
    const c = await commitToBranch(app, alice, repo, {
      message: branch,
      branch,
      files: [{ path: `${branch}.md`, content: "x\n" }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const o = await openPull(app, bot, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: o.value.id, reason: "check_failed" });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "ok", summary: "reworked" });
    }
    return getPull(app.db, repo.id, o.value.number)!;
  };
  const failed = (pull: Pull, names: string[]): Run => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "push",
      issueId: pull.id,
    });
    claimRun(app.db, run.id);
    return finishRun(app.db, run.id, {
      state: "failed",
      summary: "check failed",
      checkDetail: { passed: 1, failed: names.length, names },
    })!;
  };
  const mainGreen = () => {
    const run = createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: "a".repeat(40), reason: "push" });
    claimRun(app.db, run.id);
    announceRun(app, finishRun(app.db, run.id, { state: "ok", summary: "check passed" })!);
  };
  /** The check runner re-ran the test alone on some check and it passed: random, the lane's (#8786). */
  const flaked = (test: string) =>
    app.db.run(
      "INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file, at) VALUES (?1, ?2, 'r', 'a', ?3, 'x.test.ts', ?4)",
      [`flake-${test}`, repo.id, test, new Date().toISOString()],
    );
  const open = (pull: Pull) => getIssueById(app.db, pull.id)?.state === "open";
  const closes = (pull: Pull) => pullCloses(app, pull);
  const sharedCards = () =>
    vitals({
      db: app.db,
      dataDir: app.config.dataDir,
      signals: { errors: new ErrorLedger(), refused: new RefusedLedger() },
    }).degraded.filter((d) => d.cause.startsWith("shared:"));

  test("three pulls red on X in the hour: none parked, one card; a fourth red on Y only is parked", async () => {
    mainGreen();
    flaked("X");
    const pulls = [await spentPull(), await spentPull(), await spentPull()];
    const runs = pulls.map((p) => failed(p, ["X"]));
    for (const run of runs) announceRun(app, run);
    for (const p of pulls) expect(open(p)).toBe(true);

    const cards = sharedCards();
    expect(cards).toHaveLength(1);
    expect(cards[0]!.sentence).toContain('"X" failed on 3 pulls in the last hour');
    expect(cards[0]!.href).toBe(`/${alice.username}/${repo.name}/issues/new`);

    const own = await spentPull();
    announceRun(app, failed(own, ["Y"]));
    await closes(own);
    // X and Y together is not only the lane's red: Y is the pull's own.
    const mixed = await spentPull();
    announceRun(app, failed(mixed, ["X", "Y"]));
    await closes(mixed);
    expect(sharedCards()).toHaveLength(1);

    // Main's next green check sends the three back through the lane, once.
    requested = [];
    mainGreen();
    expect(requested.map((r) => r[4]).sort()).toEqual(pulls.map((p) => p.id).sort());
    mainGreen();
    expect(requested).toHaveLength(3);
  });

  test("three pulls red on a test main passes and no re-run passed: each is its own red, parked, and no card (#8786)", async () => {
    mainGreen();
    const pulls = [await spentPull(), await spentPull(), await spentPull()];
    for (const p of pulls) announceRun(app, failed(p, ["Z"]));
    for (const p of pulls) await closes(p);
    expect(sharedCards().map((c) => c.sentence).filter((s) => s.includes('"Z"'))).toEqual([]);
  });

  test("the card says another repository's red is not fixable here; the forge's own says nothing of it", async () => {
    const prior = process.env.FORGE_SENTINEL_REPO;
    try {
      const card = () => sharedCards()[0]!.sentence;
      process.env.FORGE_SENTINEL_REPO = "someone/else";
      expect(card()).toContain("Not fixable from this forge");
      process.env.FORGE_SENTINEL_REPO = `${alice.username}/${repo.name}`;
      expect(card()).not.toContain("Not fixable from this forge");
    } finally {
      if (prior === undefined) delete process.env.FORGE_SENTINEL_REPO;
      else process.env.FORGE_SENTINEL_REPO = prior;
    }
  });
});
