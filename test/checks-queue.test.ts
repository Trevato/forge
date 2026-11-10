/**
 * The check lane: one slot, what waits in it and what leaves it. A newer
 * commit supersedes a waiting check, a new head stops its old head's, a pull
 * that lands or closes leaves nothing behind, and a freed slot takes the
 * newest (`pickNext`) unless one has starved.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { holdsLastSlot, pickNext, STARVATION_MS } from "../src/checks/service.ts";
import {
  cancelRun,
  cancelRunsForPull,
  claimRun,
  createRun,
  getRun,
  listRuns,
  type Run,
} from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { readRunLog } from "../src/runs/log.ts";
import { checkJson, checksForge } from "./helpers/checks-forge.ts";

describe("cancelRunsForPull: a landed or closed pull leaves nothing in the lane", () => {
  test("queued and running checks and queued deploys of that pull are cancelled, building deploys and other pulls kept", async () => {
    // Invariant: cancelRunsForPull cancels that pull's queued and running checks and queued deploys, and nothing else.
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

describe("checks", () => {
  const f = checksForge("forge-checks-queue-");

  test("a newer commit supersedes a check still waiting for the same environment", async () => {
    // Invariant: a queued check is cancelled as superseded when a newer commit asks for the same environment.
    const slow = await commitToBranch(f.app, f.alice, f.repo, {
      message: "A slow check",
      files: [{ path: "forge.json", content: checkJson(f.held("supersede")) }],
    });
    if (!slow.ok) throw new Error(JSON.stringify(slow.error));
    // While that one holds the only slot, two more arrive: the first of
    // them is superseded by the second before it ever runs.
    const one = await f.checks.request(
      f.repo,
      "main",
      slow.value.commitOid,
      "push",
    );
    expect(one).toBeDefined();
    const two = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Two",
      files: [{ path: "TWO.md", content: "2\n" }],
    });
    if (!two.ok) throw new Error(JSON.stringify(two.error));
    await f.until(() => f.checksOf(two.value.commitOid).length > 0, "two queued");
    const three = await commitToBranch(f.app, f.alice, f.repo, {
      message: "Three",
      files: [{ path: "THREE.md", content: "3\n" }],
    });
    if (!three.ok) throw new Error(JSON.stringify(three.error));
    await f.until(() => f.checksOf(three.value.commitOid).length > 0, "three queued");
    f.release("supersede");
    const last = await f.settled((r) => r.commitOid === three.value.commitOid);
    expect(last.state).toBe("ok");
    const middle = f.checksOf(two.value.commitOid)[0];
    expect(middle?.state).toBe("cancelled");
    expect(middle?.summary).toContain("superseded by");
  });

  test("a new head on a pull stops its running check for the old head, superseded not failed", async () => {
    // Invariant: a pull's new head cuts off the running check of its old head, which ends cancelled as superseded.
    const slow = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "supersede",
      message: "A check that never ends on its own",
      files: [
        { path: "forge.json", content: checkJson(f.held("never")) },
        { path: "S.md", content: "s\n" },
      ],
    });
    if (!slow.ok) throw new Error(JSON.stringify(slow.error));
    const opened = await openPull(f.app, f.alice, f.repo, {
      title: "supersede",
      baseBranch: "main",
      headBranch: "supersede",
    });
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    const env = `pull-${opened.value.number}`;
    const old = await f.checks.request(
      f.repo,
      env,
      slow.value.commitOid,
      "push",
      opened.value.id,
    );
    if (!old) throw new Error("no run");
    await f.until(() => getRun(f.app.db, old.id)?.state === "running", "old head running");
    const next = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "supersede",
      message: "Fast",
      files: [
        { path: "forge.json", content: checkJson("test -f S.md") },
      ],
    });
    if (!next.ok) throw new Error(JSON.stringify(next.error));
    const fresh = await f.settled((r) => r.commitOid === next.value.commitOid);
    expect(fresh.state).toBe("ok");
    const stopped = getRun(f.app.db, old.id);
    expect(stopped?.state).toBe("cancelled");
    expect(stopped?.summary).toContain("superseded by");
    // Stopped, not only marked: the old check, which never ends on its own,
    // was cut off and wrote its end.
    await f.until(
      () => readRunLog(f.dataDir, old.id).lines.join("\n").includes("superseded"),
      "the old head's check cut off",
    );
  });

  for (const ending of ["merge", "close"] as const)
    test(`${ending === "merge" ? "merging" : "closing"} a pull leaves no queued or running run for it`, async () => {
      // Invariant: a pull merged or closed has its queued checks cancelled with that reason.
      const blocker = await commitToBranch(f.app, f.alice, f.repo, {
        message: "Hold the lane",
        files: [{ path: "forge.json", content: checkJson(f.held(`lane-${ending}`)) }],
      });
      if (!blocker.ok) throw new Error(JSON.stringify(blocker.error));
      await f.checks.request(f.repo, "lane", blocker.value.commitOid, "push");
      const branched = await commitToBranch(f.app, f.alice, f.repo, {
        branch: `lands-${ending}`,
        message: "Lands before its check runs",
        files: [{ path: "LANDS.md", content: "x\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(f.app, f.alice, f.repo, {
        title: "Lands soon",
        baseBranch: "main",
        headBranch: `lands-${ending}`,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = opened.value;
      const mine = (): Run[] =>
        listRuns(f.app.db, f.repo.id, { kind: "check" }).filter(
          (r) => r.issueId === pull.id,
        );
      await f.until(() => mine().length > 0, "the pull's check queued");
      expect(mine().some((r) => r.state === "queued")).toBe(true);
      if (ending === "merge") {
        const landed = await mergePull(f.app, f.alice, f.repo, pull, "merge");
        if (!landed.ok) throw new Error(String(landed.error));
      } else {
        const closed = setIssueState(f.app, f.alice, f.repo, pull, "closed");
        if (!closed.ok) throw new Error(String(closed.error));
      }
      await f.until(() => mine().every((r) => r.state !== "queued"), "the pull's check gone");
      expect(mine().filter((r) => r.state === "queued")).toEqual([]);
      expect(
        mine().some(
          (r) =>
            r.summary === (ending === "merge" ? "pull landed" : "pull closed"),
        ),
      ).toBe(true);
      // The lane is let go, and left empty for the next test.
      f.release(`lane-${ending}`);
      await f.until(
        () => f.checksOf(blocker.value.commitOid).every((r) => r.state !== "queued" && r.state !== "running"),
        "the lane's holder done",
      );
    });

  test("a queued gate keeps the last free slot from pull checks", () => {
    // One slot free, a gate queued: the pull check passes, the gate starts.
    expect(holdsLastSlot(1, true)).toBe(true);
    // With no gate queued the pull check takes it, as every slot.
    expect(holdsLastSlot(1, false)).toBe(false);
    // More than one free: the pull check starts, one is still left.
    expect(holdsLastSlot(2, true)).toBe(false);
  });

  test("pickNext takes the newest queued check, unless one has starved", () => {
    const a = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "a" });
    const b = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "b" });
    const c = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "c" });
    // ids are creation-ordered, so this is oldest-to-newest already.
    expect(pickNext([a, b, c])?.id).toBe(c.id);
    expect(pickNext([c, a, b])?.id).toBe(c.id);
    expect(pickNext([a])?.id).toBe(a.id);
    expect(pickNext([])).toBeUndefined();

    // `a` has waited past the starvation bound: it outranks `c`, however new.
    f.app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(a.id, new Date(Date.now() - STARVATION_MS - 1_000).toISOString());
    const starved = getRun(f.app.db, a.id)!;
    expect(pickNext([starved, b, c])?.id).toBe(starved.id);
    // Just short of the bound, the newest still wins.
    f.app.db
      .query("UPDATE run SET created_at = ?2 WHERE id = ?1")
      .run(a.id, new Date(Date.now() - STARVATION_MS + 1_000).toISOString());
    expect(pickNext([getRun(f.app.db, a.id)!, b, c])?.id).toBe(c.id);

    // These never named a real commit: cancel them rather than leave them
    // for the live checks service running beside this test to trip over.
    for (const run of [a, b, c]) cancelRun(f.app.db, run.id);
  });

  test("pickNext puts an approved pull's check first, newest among them, and the starved before all", () => {
    const a = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "a" });
    const b = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "b" });
    const c = createRun(f.app.db, { repoId: f.repo.id, kind: "check", env: "c" });
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
    for (const run of [a, b, c]) cancelRun(f.app.db, run.id);
  });

  test("when a slot frees, the newest of several queued checks runs first", async () => {
    // Invariant: of several checks queued behind a held slot, the newest starts first.
    // Three checks, on three environments so none supersedes another. Their
    // commits are written before the slot is taken: written after, on a
    // loaded machine they can outlast the holder, and the oldest then finds
    // the slot free instead of queueing.
    const oldest = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "order-a",
      message: "A",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!oldest.ok) throw new Error(JSON.stringify(oldest.error));
    const middle = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "order-b",
      message: "B",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!middle.ok) throw new Error(JSON.stringify(middle.error));
    const newest = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "order-c",
      message: "C",
      files: [{ path: "forge.json", content: checkJson("test -f OK.md") }],
    });
    if (!newest.ok) throw new Error(JSON.stringify(newest.error));

    // A slow check on its own environment holds the only slot, and the
    // three queue behind it — oldest requested first.
    const holding = await commitToBranch(f.app, f.alice, f.repo, {
      branch: "order-hold",
      message: "Hold the slot",
      files: [
        { path: "forge.json", content: checkJson(f.held("order")) },
      ],
    });
    if (!holding.ok) throw new Error(JSON.stringify(holding.error));
    const holder = await f.checks.request(
      f.repo,
      "order-hold",
      holding.value.commitOid,
      "push",
    );
    expect(holder).toBeDefined();

    const oldestRun = await f.checks.request(
      f.repo,
      "order-a",
      oldest.value.commitOid,
      "push",
    );
    const middleRun = await f.checks.request(
      f.repo,
      "order-b",
      middle.value.commitOid,
      "push",
    );
    const newestRun = await f.checks.request(
      f.repo,
      "order-c",
      newest.value.commitOid,
      "push",
    );
    expect(oldestRun && middleRun && newestRun).toBeTruthy();
    expect(oldestRun?.state).toBe("queued");
    expect(middleRun?.state).toBe("queued");
    expect(newestRun?.state).toBe("queued");

    f.release("order");
    await f.settled((r) => r.id === newestRun!.id);
    await f.settled((r) => r.id === middleRun!.id);
    await f.settled((r) => r.id === oldestRun!.id);

    const runs = listRuns(f.app.db, f.repo.id, { kind: "check", limit: 50 });
    const startedAt = (id: string): number =>
      Date.parse(runs.find((r) => r.id === id)!.startedAt!);
    expect(startedAt(newestRun!.id)).toBeLessThan(startedAt(middleRun!.id));
    expect(startedAt(middleRun!.id)).toBeLessThan(startedAt(oldestRun!.id));
  });
  test("a check whose pull lands while it runs ends as superseded, not failed", async () => {
    // Invariant: a running check whose row is cancelled under it logs superseded with the reason, never failed, even when its command fails.
    const id = await f.slowCheck(f.held("overtaken", "false"), "A check overtaken");
    cancelRun(f.app.db, id, "pull landed");
    f.release("overtaken");
    const log = (): string => readRunLog(f.dataDir, id).lines.join("\n");
    await f.until(() => log().includes("superseded"), "superseded in the log");
    const lines = log();
    expect(lines).toContain("superseded: pull landed");
    expect(lines).not.toContain("failed:");
    expect(getRun(f.app.db, id)?.state).toBe("cancelled");
  });
});
