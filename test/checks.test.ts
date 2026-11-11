/**
 * A repository's own check, run by the forge: `check` in forge.json, on
 * every push a pull or the default branch takes, the verdict a run beside
 * the pull — the same place a preview's deploy reports. This file: what
 * asks for a check and what its verdict says. The lane's order is
 * `checks-queue.test.ts`; a stopping or dying forge, `checks-restart.test.ts`;
 * the failure summary's parsing, `checks-failure-summary.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { startChecks } from "../src/checks/service.ts";
import { checkSummary, checksForHead, listRuns, type Run } from "../src/core/runs.ts";
import { checksText } from "../src/tui/screens/pull.ts";
import { checksLine } from "../src/web/pages/pull.ts";
import { createUser } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";
import { serve } from "../src/http/server.ts";
import { listEvents } from "../src/core/events.ts";
import { readRunLog } from "../src/runs/log.ts";
import { checkJson, checksForge } from "./helpers/checks-forge.ts";

describe("checks", () => {
  const f = checksForge("forge-checks-");

  test("a commit that declares no check is not checked", async () => {
    // Invariant: a push whose commit declares no check queues no run; the next push that declares one is the only run.
    const seeded = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# lib\n" }],
    });
    expect(seeded.ok).toBe(true);
    // The push after it declares a check: once that one settles, the
    // first push's handler (begun earlier, doing no more) has answered too.
    const declared = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Declare a passing check",
      files: [{ path: "forge.json", content: checkJson("true # first") }],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    const run = await f.settled((r) => r.commitOid === declared.value.commitOid);
    expect(listRuns(f.app.db, f.repo.id, { kind: "check" }).map((r) => r.id)).toEqual([run.id]);
  });

  test("the default branch is checked on push, with the log kept", async () => {
    // Invariant: a push to the default branch that declares a check runs it, env main, reason push, its commands in the log.
    const declared = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Declare a check",
      files: [
        { path: "forge.json", content: checkJson("test -f OK.md") },
        { path: "OK.md", content: "ok\n" },
      ],
    });
    if (!declared.ok) throw new Error(JSON.stringify(declared.error));
    const run = await f.settled((r) => r.commitOid === declared.value.commitOid);
    expect(run.state).toBe("ok");
    expect(run.env).toBe("main");
    expect(run.reason).toBe("push");
    expect(run.summary).toMatch(/^check passed in \d+s$/);
    const log = readRunLog(f.dataDir, run.id).lines.join("\n");
    expect(log).toContain("$ test -f OK.md");
  });

  test("a check's children hold no cells of their own: the check's cell is the boundary", async () => {
    // Invariant: a check's command sees FORGE_CELLS=off.
    // A forge the tests boot inside a check cell must not wrap its apps in
    // nested cells (they never answer in time); it is told so in its env.
    const declared = await commitToBranch(f.app, f.alice, f.repo, {
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
    const run = await f.settled((r) => r.commitOid === declared.value.commitOid);
    expect(run.state).toBe("ok");
    expect(readRunLog(f.dataDir, run.id).lines.join("\n")).toContain(
      "cells: off",
    );
  });

  test("a pull is checked when it opens and each time its branch moves; a failure names the exit", async () => {
    // Invariant: a branch heading no pull is not checked; opening a pull checks its head with the base's check, and each push to it again.
    // A pull is checked by the base's check, not its own.
    const gate = await commitToBranch(f.app, f.alice, f.repo, {
      message: "The base's check",
      files: [{ path: "forge.json", content: checkJson("test -f NOPE.md") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branched = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "feature",
      message: "Leave the check failing",
      files: [{ path: "a.txt", content: "a\n" }],
    });
    if (!branched.ok) throw new Error(JSON.stringify(branched.error));
    const opened = await openPull(f.app, f.alice, f.repo, {
      title: "Feature",
      baseBranch: "main",
      headBranch: "feature",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const failed = await f.settled(
      (r) => r.issueId === pull.id && r.commitOid === branched.value.commitOid,
    );
    expect(failed.state).toBe("failed");
    expect(failed.env).toBe(`pull-${pull.number}`);
    expect(failed.reason).toBe("pull");
    // A branch that heads no pull is nobody's to check: its push, handled
    // before the pull opened, left no run beside the pull's own.
    expect(f.checksOf(branched.value.commitOid).map((r) => r.id)).toEqual([failed.id]);
    expect(failed.summary).toBe("check failed: check exited with code 1");
    // `test -f` is not `bun test`: its output is not this shape, so nothing
    // is guessed at it.
    // ... but the disk's free share is recorded on every red (#5453).
    expect(failed.checkDetail?.names).toEqual([]);
    expect(typeof failed.checkDetail?.diskFree).toBe("number");
    // The check names the base tip it merged with; a default-branch push
    // merged nothing and records none (#1810).
    expect(failed.baseOid).toBe(gate.value.commitOid);
    const onMain = await f.settled((r) => r.commitOid === gate.value.commitOid && r.issueId === null);
    expect(onMain.baseOid).toBe("");
    const seen = checkSummary(f.app.db, pull.id, branched.value.commitOid);
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
      checksForHead(f.app.db, pull.id, branched.value.commitOid)[0]?.id,
    ).toBe(failed.id);

    const fixed = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "feature",
      message: "Fix the check",
      files: [{ path: "NOPE.md", content: "there\n" }],
    });
    if (!fixed.ok) throw new Error(JSON.stringify(fixed.error));
    const passed = await f.settled(
      (r) => r.issueId === pull.id && r.commitOid === fixed.value.commitOid,
    );
    expect(passed.state).toBe("ok");
    expect(passed.reason).toBe("push");
  });

  test("a bun test failure in the check step is summarised: how many passed, how many failed, and their names", async () => {
    // Invariant: a red `bun test` check's summary and detail carry the counts and the failing names.
    const gate = await commitToBranch(f.app, f.alice, f.repo, {
      message: "The base's check runs bun test",
      files: [
        { path: "forge.json", content: checkJson("bun test check.test.ts") },
      ],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const branched = await commitToBranch(f.app, f.alice, f.repo, {
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
    const opened = await openPull(f.app, f.alice, f.repo, {
      title: "Red tests",
      baseBranch: "main",
      headBranch: "red-tests",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const failed = await f.settled(
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
  });

  test("a reader's fork pull is checked at the base's snapshot once a writer approves each head", async () => {
    // Invariant: a reader's fork pull runs nothing until a writer approves, and each new head waits for its own approval.
    const gate = await commitToBranch(f.app, f.alice, f.repo, {
      message: "The base's check passes",
      files: [{ path: "forge.json", content: checkJson("true") }],
    });
    if (!gate.ok) throw new Error(JSON.stringify(gate.error));
    const forked = await forkRepo(f.app, f.bob, f.repo);
    if (!forked.ok) throw new Error(String(forked.error));
    const fork = forked.value;
    const committed = await commitToBranch(f.app, f.bob, fork, {
      branch: "from-fork",
      message: "From the fork",
      files: [{ path: "FORK.md", content: "hi\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(f.app, f.bob, f.repo, {
      title: "From the fork",
      baseBranch: "main",
      headBranch: "from-fork",
      headRepo: fork,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    expect(pull.crossRepo).toBe(true);
    // Bob cannot write: nothing of his runs until Alice approves the head.
    const approved = await submitReview(f.app, f.alice, f.repo, pull, {
      state: "approved",
    });
    if (!approved.ok) throw new Error(String(approved.error));
    const first = await f.settled(
      (r) => r.issueId === pull.id && r.commitOid === committed.value.commitOid,
    );
    expect(first.state).toBe("ok");
    // The fork pushes again: the base's snapshot moves, and so does the check.
    const again = await commitToBranch(f.app, f.bob, fork, {
      branch: "from-fork",
      message: "Again",
      files: [{ path: "FORK.md", content: "hi again\n" }],
    });
    if (!again.ok) throw new Error(JSON.stringify(again.error));
    // The pull follows the fork's branch on its own clock: approve the new
    // head only once its move was announced and answered (the bus delivers
    // in step, so the push's handler has met the approval guard by then).
    await f.headAnnounced(pull, again.value.commitOid);
    const reapproved = await submitReview(f.app, f.alice, f.repo, pull, {
      state: "approved",
    });
    if (!reapproved.ok) throw new Error(String(reapproved.error));
    const second = await f.settled(
      (r) => r.issueId === pull.id && r.commitOid === again.value.commitOid,
    );
    expect(second.state).toBe("ok");
    // A new head waits for its own approval: the push, handled before the
    // approval was given, ran nothing; the one check is the approval's.
    expect(second.reason).toBe("approved");
    expect(f.checksOf(again.value.commitOid).map((r) => r.id)).toEqual([second.id]);
  });

  test("approving a head whose check is already green queues no second check (#4391)", async () => {
    // Invariant: a second approval of a head already green on the same base queues nothing.
    const based = await commitToBranch(f.app, f.alice, f.repo, {
      message: "The base's check passes",
      files: [{ path: "forge.json", content: checkJson("true") }],
    });
    if (!based.ok) throw new Error(JSON.stringify(based.error));
    // Bob's fork, made by the fork test above when it ran first.
    const fork =
      getRepo(f.app.db, "bob", f.repo.name) ??
      (await forkRepo(f.app, f.bob, f.repo).then((made) => (made.ok ? made.value : undefined)));
    if (fork === undefined) throw new Error("no fork");
    const committed = await commitToBranch(f.app, f.bob, fork, {
      branch: "green-then-approved",
      message: "Green before the second look",
      files: [{ path: "GREEN.md", content: "x\n" }],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const opened = await openPull(f.app, f.bob, f.repo, {
      title: "Green before the second look",
      baseBranch: "main",
      headBranch: "green-then-approved",
      headRepo: fork,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = opened.value;
    const mine = (): Run[] =>
      listRuns(f.app.db, f.repo.id, { kind: "check" }).filter(
        (r) => r.issueId === pull.id && r.commitOid === committed.value.commitOid,
      );
    // The first approval is what lets a reader's head run at all.
    const approved = await submitReview(f.app, f.alice, f.repo, pull, { state: "approved" });
    if (!approved.ok) throw new Error(String(approved.error));
    const first = await f.settled((r) => r.issueId === pull.id);
    expect(first.state).toBe("ok");
    // A second approval of the same green head on the same base is nothing new.
    const again = await submitReview(f.app, f.alice, f.repo, pull, {
      state: "approved",
      body: "Still good.",
    });
    if (!again.ok) throw new Error(String(again.error));
    // The fork moves on and its new head is approved: once that check
    // settles, the second approval's handler (begun earlier, doing no
    // more) has answered too.
    const next = await commitToBranch(f.app, f.bob, fork, {
      branch: "green-then-approved",
      message: "After the second look",
      files: [{ path: "GREEN.md", content: "y\n" }],
    });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    await f.headAnnounced(pull, next.value.commitOid);
    const third = await submitReview(f.app, f.alice, f.repo, pull, { state: "approved" });
    if (!third.ok) throw new Error(String(third.error));
    await f.settled((r) => r.issueId === pull.id && r.commitOid === next.value.commitOid);
    expect(mine().map((r) => r.id)).toEqual([first.id]);
  });

  test("a commit already proven green is not run again; the re-request answers with the earlier verdict (#1795)", async () => {
    // Invariant: a re-requested check of a commit already green answers with that verdict without running the command.
    const made = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Proven once",
      files: [
        { path: "forge.json", content: checkJson("echo ran-once; test -f OK.md # proven") },
        { path: "OK.md", content: "ok\n" },
      ],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const first = await f.settled((r) => r.commitOid === made.value.commitOid);
    expect(first.state).toBe("ok");
    expect(readRunLog(f.dataDir, first.id).lines.join("\n")).toContain("ran-once");
    const asked = await f.checks.request(f.repo, "main", made.value.commitOid, "again");
    const second = await f.settled((r) => r.id === asked!.id);
    expect(second.state).toBe("ok");
    expect(second.summary).toBe(`already proven green by ${first.id}`);
    expect(readRunLog(f.dataDir, second.id).lines.join("\n")).not.toContain("ran-once");
  });
  test("a check that is declared wrong fails with the reason", async () => {
    // Invariant: a malformed check declaration fails the run with the parse reason.
    const wrong = await commitToBranch(f.app, f.alice, f.repo, {
      message: "A wrong check",
      files: [{ path: "forge.json", content: '{"check": "bun test"}\n' }],
    });
    if (!wrong.ok) throw new Error(JSON.stringify(wrong.error));
    const run = await f.settled((r) => r.commitOid === wrong.value.commitOid);
    expect(run.state).toBe("failed");
    expect(run.summary).toBe(
      "check failed: forge.json: check must be an object",
    );
  });
});

describe("checks: a finished shard is announced as the runner writes it (#2889)", () => {
  test("each shard-done line the check prints puts one run.shard on the bus, and nothing else does", async () => {
    // Invariant: each `shard N/M done` line a check prints emits one run.shard event for that run.
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
        await Bun.sleep(10);
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
