/**
 * A repository's own check, run by the forge: `check` in forge.json, on
 * every push a pull or the default branch takes, the verdict a run beside
 * the pull — the same place a preview's deploy reports.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import {
  pickNext,
  startChecks,
  STARVATION_MS,
  type ChecksHandle,
} from "../src/checks/service.ts";
import {
  cancelRun,
  checksForHead,
  createRun,
  getRun,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { readRunLog } from "../src/runs/log.ts";

const checkJson = (run: string, extra = ""): string =>
  `{"check": {"run": ${JSON.stringify(run)}, "install": ""${extra}}}\n`;

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
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, {
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
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

  test("a pull is checked when it opens and each time its branch moves; a failure names the exit", async () => {
    const branched = await commitToBranch(app, alice, repo, {
      branch: "feature",
      message: "Break the check",
      files: [{ path: "forge.json", content: checkJson("test -f NOPE.md") }],
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

  test("a fork's pull is checked at the base's snapshot, and follows the fork's pushes", async () => {
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
    const second = await settled(
      (r) => r.issueId === pull.id && r.commitOid === again.value.commitOid,
    );
    expect(second.state).toBe("ok");
  }, 60_000);

  test("a newer commit supersedes a check still waiting for the same environment", async () => {
    const slow = await commitToBranch(app, alice, repo, {
      message: "A slow check",
      files: [
        { path: "forge.json", content: checkJson("sleep 2 && test -f OK.md") },
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

  test("when a slot frees, the newest of several queued checks runs first", async () => {
    // A slow check on its own environment holds the only slot.
    const held = await commitToBranch(app, alice, repo, {
      branch: "order-hold",
      message: "Hold the slot",
      files: [
        { path: "forge.json", content: checkJson("sleep 2 && test -f OK.md") },
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

    // Three more, on three environments so none supersedes another, queue
    // behind it — oldest requested first.
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
        { path: "forge.json", content: checkJson("sleep 3 && test -f OK.md") },
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
    const branch = await commitToBranch(app, alice, repo, {
      branch: "quiet",
      message: "Quiet",
      files: [
        { path: "QUIET.md", content: "quiet\n" },
        { path: "forge.json", content: checkJson("test -f QUIET.md") },
      ],
    });
    if (!branch.ok) throw new Error(JSON.stringify(branch.error));
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
