/**
 * Approved pulls whose green went stale land together (#3316). Each check
 * passed against an older base; main moved. The merge queue does not ask
 * each pull for a check of its own first: the candidate's full gate runs
 * on main's tip with every one of them merged, and that is the proof. A
 * batch of N lands in one gate, not N re-checks and N gates. A person's
 * merge, which no gate ran for, still refuses a stale green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { gateRuns } from "../src/checks/queue.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, setRunBase } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { lastWaits, tallyWaits, waitWords } from "../src/crew/waits.ts";
import { repoDir } from "../src/git/repos.ts";

describe("stale greens land in one candidate", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bob: User;
  let repo: Repo;
  /** Every check the queue asked for: the stand-in runs it green on main's tip. */
  const asked: { commit: string; reason: string }[] = [];
  const fresh = () => getRepoById(app.db, repo.id)!;
  const mainTip = () =>
    Bun.spawnSync(["git", "rev-parse", "refs/heads/main"], {
      cwd: repoDir(app.reposRoot, repo.ownerName, repo.name),
    })
      .stdout.toString()
      .trim();

  function passCheck(pull: Pull, commit: string, reason: string) {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: commit,
      reason,
    });
    claimRun(app.db, run.id);
    setRunBase(app.db, run.id, mainTip());
    return finishRun(app.db, run.id, { state: "ok", summary: "check passed" });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stale-recheck-"));
    app = createApp({ dataDir, port: 0 });
    const made = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    alice = await made("alice");
    bob = await made("bob");
    const created = await createRepo(app, alice, { name: "engine", visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# engine\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2, require_checks = 1 WHERE id = ?1",
      )
      .run(repo.id, alice.id);
    provideChecksForTest(app, {
      gate: async () => ({ ok: true, error: "", lines: [] }),
      request: async (_repo: Repo, _env: string, commit: string, reason: string, issueId?: string) => {
        asked.push({ commit, reason });
        const pull = [...app.db
          .query<{ number: number }, [string]>("SELECT number FROM issue WHERE id = ?1")
          .all(issueId ?? "")][0];
        return pull === undefined
          ? undefined
          : passCheck(getPull(app.db, repo.id, pull.number)!, commit, reason);
      },
    } as unknown as ChecksHandle);
  });

  afterAll(async () => {
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function approvedGreen(name: string): Promise<Pull> {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: `feature/${name}`,
      base: "main",
      message: name,
      files: [{ path: `${name}.ts`, content: `export const ${name} = 1;\n` }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, repo, {
      title: name,
      baseBranch: "main",
      headBranch: `feature/${name}`,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    passCheck(pull, pull.headOid, "pull");
    submitReview(app.db, {
      issueId: pull.id,
      authorId: bob.id,
      state: "approved",
      commitOid: pull.headOid,
    });
    return pull;
  }

  async function moveMain(path: string): Promise<void> {
    const moved = await commitToBranch(app, alice, repo, {
      message: path,
      files: [{ path, content: "export const moved = 1;\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
  }

  test("a person's merge still refuses a green on an older main", async () => {
    const pull = await approvedGreen("manual");
    await moveMain("before-manual.ts");
    app.db.query("UPDATE repo SET autonomy = 'off' WHERE id = ?1").run(repo.id);
    try {
      const merged = await mergePull(app, alice, fresh(), pull, "squash");
      expect(merged.ok).toBe(false);
      if (!merged.ok) expect(merged.error).toBe("checks_required");
    } finally {
      app.db.query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1").run(repo.id);
    }
  });

  test("five approved pulls, main moves, and all five land in one candidate", async () => {
    const pulls = [];
    for (const name of ["a", "b", "c", "d", "e"]) pulls.push(await approvedGreen(name));
    // Main moves past the base every green was checked on.
    await moveMain("elsewhere.ts");
    const before = mainTip();
    const gatesBefore = gateRuns(repo.id);
    asked.length = 0;

    // One sweep: no pull is asked for a check of its own, one gate runs,
    // and every pull lands (the person's one from the test above too).
    expect(await sweepGreen(app, fresh())).toBe(6);
    expect(asked).toEqual([]);
    expect(gateRuns(repo.id) - gatesBefore).toBe(1);
    for (const pull of pulls) expect(getPull(app.db, repo.id, pull.number)!.mergedAt).not.toBeNull();
    expect(mainTip()).not.toBe(before);
    expect(lastWaits(repo.id)).toEqual({ queued: 6 });
  });
});

describe("the tick's words for approved pulls that wait", () => {
  test("say how many, and why, most first", () => {
    expect(waitWords(tallyWaits(["review", "queued", "review", "conflict"]))).toBe(
      "4 approved: review=2 conflict=1 queued=1",
    );
  });

  test("say nothing when no approved pull waits", () => {
    expect(waitWords(tallyWaits([]))).toBeUndefined();
  });
});
