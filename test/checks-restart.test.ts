/**
 * A check across the forge's own stops: a release that stops the service
 * (queued again, or drained to its verdict), a person's stop, a boot that
 * finds an open pull never checked, a check whose forge died under it
 * (`requeueAbandonedChecks`), and the boot sweep of checkouts nobody runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { requeueAbandonedChecks, startChecks, sweepSoon } from "../src/checks/service.ts";
import {
  cancelRun,
  CHECK_RESTART_LIMIT,
  claimRun,
  createRun,
  getRun,
  listRuns,
  REQUEUED_SUMMARY,
  type Run,
} from "../src/core/runs.ts";
import type { Pull } from "../src/core/pulls.ts";
import { repoDir } from "../src/git/repos.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { pullWord, servingHistory } from "../src/web/studio/words.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { checkJson, checksForge } from "./helpers/checks-forge.ts";

describe("checks", () => {
  const f = checksForge("forge-checks-restart-");

  test("a check in flight when the forge stops is queued again, and the next forge runs it", async () => {
    // Invariant: stopping the service cancels a running check as queued again, attempt + 1, and the next service runs it to the end.
    // Hangs the first time it runs, passes the second: no wait to tune.
    const id = await f.slowCheck(
      `if [ -f '${f.dataDir}/ran-once' ]; then test -f OK.md; else touch '${f.dataDir}/ran-once'; ${f.held("never")}; fi`,
      "A slower check",
    );
    // Running is said before the command begins: stop only once it has.
    await f.until(() => existsSync(join(f.dataDir, "ran-once")), "the command begun");
    const oid = getRun(f.app.db, id)!.commitOid;
    const cut = getRun(f.app.db, id);

    // This forge stops — a release — with the check under way.
    await f.checks.stop();
    const runs = listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 });
    const interrupted = runs.find((r) => r.id === cut!.id);
    expect(interrupted?.state).toBe("cancelled");
    expect(interrupted?.summary).toContain("queued again");
    const again = runs.find((r) => r.commitOid === oid && r.state === "queued");
    expect(again?.attempt).toBe(1);

    // The forge that carries on finds it queued and runs it to the end.
    f.checks = startChecks(f.app, { forgeUrl: f.servers.url, concurrency: 1 });
    const done = await f.settled((r) => r.id === again!.id);
    expect(done.state).toBe("ok");
  });
  test("a roll waits for a running check to finish, within its budget, instead of throwing it away", async () => {
    // Invariant: stop with a drain budget lets a running check finish to its verdict, leaving nothing queued.
    await f.checks.stop();
    f.checks = startChecks(f.app, {
      forgeUrl: f.servers.url,
      concurrency: 1,
      drainMs: 30_000,
    });
    const id = await f.slowCheck(f.held("drained"), "A drained check");
    // Let go only once the stop is under way: a stop that did not wait
    // would have cut it off already.
    const stopping = f.checks.stop();
    f.release("drained");
    await stopping;
    const run = getRun(f.app.db, id);
    expect(run?.state).toBe("ok");
    expect(
      listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 }).some(
        (r) => r.state === "queued",
      ),
    ).toBe(false);
    f.checks = startChecks(f.app, { forgeUrl: f.servers.url, concurrency: 1 });
  });

  test("a person's stop cuts a running check off at once, and queues it again", async () => {
    // Invariant: stop without drain cancels a running check at once as queued again, and the next service runs it.
    await f.checks.stop();
    f.checks = startChecks(f.app, {
      forgeUrl: f.servers.url,
      concurrency: 1,
      drainMs: 30_000,
    });
    const id = await f.slowCheck(f.held("cut"), "A cut-off check");
    await f.checks.stop({ drain: false });
    const run = getRun(f.app.db, id);
    expect(run?.state).toBe("cancelled");
    expect(run?.summary).toContain("queued again");
    const again = listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 }).find(
      (r) => r.commitOid === run?.commitOid && r.state === "queued",
    );
    expect(again).toBeDefined();
    f.release("cut");
    f.checks = startChecks(f.app, { forgeUrl: f.servers.url, concurrency: 1 });
    const done = await f.settled((r) => r.id === again?.id);
    expect(done.state).toBe("ok");
  });
  test("an open pull whose head was never checked is checked when the service boots", async () => {
    // Invariant: a booting service checks the head of an open pull that has no check, with reason boot.
    await f.checks.stop();
    // The pull is checked by the base's check, so the base must ask for it.
    const gate = await commitToBranch(f.app, f.alice, f.repo, {
      message: "The base's check wants QUIET.md",
      files: [{ path: "forge.json", content: checkJson("test -f QUIET.md") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branch = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "quiet",
      message: "Quiet",
      files: [{ path: "QUIET.md", content: "quiet\n" }],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
    // The pull's check is the base's (#1275): give main a valid one.
    const base = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "main",
      message: "The base's check",
      files: [{ path: "forge.json", content: checkJson("test -f QUIET.md") }],
    });
    if (!base.ok) throw new Error(JSON.stringify(base.error));
    // Opened while no checks service was listening: nothing asked for a check.
    const opened = await openPull(f.app, f.alice, f.repo, {
      title: "Quiet",
      baseBranch: "main",
      headBranch: "quiet",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(
      listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 }).filter(
        (r) => r.commitOid === opened.value.headOid,
      ),
    ).toHaveLength(0);
    f.checks = startChecks(f.app, { forgeUrl: f.servers.url, concurrency: 1 });
    const done = await f.settled((r) => r.commitOid === opened.value.headOid);
    expect(done.reason).toBe("boot");
    expect(done.state).toBe("ok");
  });
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
    // Invariant: the boot sweep removes checkouts of lapsed or unknown runs and keeps a live run's.
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
