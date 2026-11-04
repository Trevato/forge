/**
 * A merge conflict is not a failed try (#7909): a check that could not start
 * because the pull "does not merge into main" never counts towards
 * CHECK_FAILED_LIMIT and never parks it. A clash only in a list doc is
 * settled by the forge keeping both sides; any other queues one
 * bring-up-to-date run.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { announceRun } from "../src/actions/runs.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { NO_MERGE } from "../src/checks/merged.ts";
import { CHECK_FAILED_LIMIT } from "../src/crew/dispatch.ts";
import { getIssueById } from "../src/core/issues.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { automaticRunsSince, claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { onlyListDocs } from "../src/actions/list-conflicts.ts";
import { sweepConflicts } from "../src/crew/autonomy.ts";
import { getRepoById } from "../src/core/repos.ts";
import { runGitCapture } from "../src/git/env.ts";
import { unionMergeFile } from "../src/git/union-merge.ts";
import { repoDir } from "../src/git/repos.ts";
import { startStandInCrew, stopStandInCrew, type StandInCrew } from "./helpers/crew-standin.ts";

describe("the crew, with a pull that does not merge", () => {
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

  const commit = async (branch: string, path: string, content: string) => {
    const c = await commitToBranch(app, alice, repo, {
      message: `${branch} ${path}`,
      branch,
      ...(branch === "main" ? {} : { base: "main" }),
      files: [{ path, content }],
    });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
  };

  /** A pull whose automatic tries are spent, conflicting with main in `path`. */
  const conflicted = async (path: string): Promise<Pull> => {
    const branch = `clash-${++n}`;
    await commit("main", path, "- base\n");
    await commit(branch, path, "- base\n- theirs\n");
    const o = await openPull(app, bot, repo, { title: branch, baseBranch: "main", headBranch: branch });
    if (!o.ok) throw new Error(String(o.error));
    app.db.run("UPDATE issue SET assignee_id = ?1 WHERE id = ?2", [bot.id, o.value.id]);
    for (let i = 0; i < CHECK_FAILED_LIMIT; i++) {
      const tried = createRun(app.db, { repoId: repo.id, kind: "agent", issueId: o.value.id, reason: "check_failed" });
      claimRun(app.db, tried.id);
      finishRun(app.db, tried.id, { state: "ok", summary: "reworked" });
    }
    await commit("main", path, "- base\n- ours\n");
    return getPull(app.db, repo.id, o.value.number)!;
  };
  const redForConflict = (pull: Pull) => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "push",
      issueId: pull.id,
    });
    claimRun(app.db, run.id);
    announceRun(
      app,
      finishRun(app.db, run.id, { state: "failed", summary: `${NO_MERGE} main: docs/x.ts` })!,
    );
  };
  const conflictRuns = (pull: Pull) =>
    listRuns(app.db, repo.id, { kind: "agent" }).filter((r) => r.issueId === pull.id && r.reason === "conflict");
  /** Poll `done` until true, at most `ms`; the test's own expects then say what failed. */
  const until = async (done: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!done() && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    if (!done()) throw new Error(`never came: still waiting while !done()`);
  };
  const headOf = (pull: Pull) => getPull(app.db, repo.id, pull.number)!.headOid;
  const fileAt = async (oid: string, path: string) =>
    (await runGitCapture(["cat-file", "blob", `${oid}:${path}`], { cwd: repoDir(app.reposRoot, alice.username, repo.name) })).stdout;

  test("a clash outside the list docs queues a bring-up-to-date run, is no try and parks nothing", async () => {
    const pull = await conflicted("src/shared.ts");
    // Two reds: one in flight is enough.
    redForConflict(pull);
    redForConflict(pull);
    await until(() => conflictRuns(pull).length > 0);
    // The list-doc pull below is handled after both: its head moving means the reds were seen.
    const listed = await conflicted("docs/MCP.md");
    redForConflict(listed);
    await until(() => headOf(listed) !== listed.headOid);
    expect(getIssueById(app.db, pull.id)?.state).toBe("open");
    expect(conflictRuns(pull)).toHaveLength(1);
    expect(automaticRunsSince(app.db, pull.id, "1970-01-01T00:00:00.000Z")).toBe(CHECK_FAILED_LIMIT);
  });

  test("a clash only in docs/MCP.md keeps both sides with no run", async () => {
    const pull = await conflicted("docs/MCP.md");
    redForConflict(pull);
    await until(() => headOf(pull) !== pull.headOid);
    expect(headOf(pull)).not.toBe(pull.headOid);
    const doc = await fileAt(headOf(pull), "docs/MCP.md");
    expect(doc).toContain("- ours");
    expect(doc).toContain("- theirs");
    expect(doc).not.toContain("<<<<<<<");
    expect(conflictRuns(pull)).toHaveLength(0);
    expect(getIssueById(app.db, pull.id)?.state).toBe("open");
  });

  test("the sweep settles a list-doc clash itself, with no run", async () => {
    const pull = await conflicted("docs/MCP.md");
    app.db.run("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1", [repo.id]);
    // The sweep starts work only when the lane has room: clear the runs earlier tests queued.
    for (const r of listRuns(app.db, repo.id, { kind: "agent" }))
      if (r.state === "queued" || r.state === "running") {
        claimRun(app.db, r.id);
        finishRun(app.db, r.id, { state: "ok", summary: "cleared" });
      }
    // And the earlier tests' pulls: each run the sweep starts takes a slot of the lane's one.
    app.db.run("UPDATE issue SET state = 'closed' WHERE repo_id = ?1 AND id != ?2 AND state = 'open'", [repo.id, pull.id]);
    await sweepConflicts(app, getRepoById(app.db, repo.id)!);
    expect(headOf(pull)).not.toBe(pull.headOid);
    const doc = await fileAt(headOf(pull), "docs/MCP.md");
    expect(doc).toContain("- ours");
    expect(doc).toContain("- theirs");
    expect(conflictRuns(pull)).toHaveLength(0);
  });

  test("prose docs are left to a run", async () => {
    expect(onlyListDocs(["README.md"])).toBe(false);
    expect(onlyListDocs(["CHANGELOG.md"])).toBe(false);
  });

  test("a real union merge keeps both sides' lines", async () => {
    const dir = repoDir(app.reposRoot, alice.username, repo.name);
    await commit("main", "docs/MCP.md", "- base\n");
    const base = (await runGitCapture(["rev-parse", "main"], { cwd: dir })).stdout.trim();
    await commit("main", "docs/MCP.md", "- base\n- ours\n");
    const ours = (await runGitCapture(["rev-parse", "main"], { cwd: dir })).stdout.trim();
    await commit(`union-${++n}`, "docs/MCP.md", "- base\n- theirs\n");
    const theirs = (await runGitCapture(["rev-parse", `union-${n}`], { cwd: dir })).stdout.trim();
    const merged = await unionMergeFile(dir, base, ours, theirs, "docs/MCP.md");
    expect(merged).toContain("- base");
    expect(merged).toContain("- ours");
    expect(merged).toContain("- theirs");
    expect(merged).not.toContain("<<<<<<<");
  });

  test("union merge: only list docs qualify", async () => {
    expect(onlyListDocs(["docs/MCP.md"])).toBe(true);
    expect(onlyListDocs(["docs/MCP.md", "src/a.ts"])).toBe(false);
    expect(onlyListDocs([])).toBe(false);
    expect(await unionMergeFile(repoDir(app.reposRoot, alice.username, repo.name), "x", "y", "z", "docs/MCP.md")).toBeUndefined();
  });
});
