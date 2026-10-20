/**
 * An approved pull whose green went stale lands on its own (#3055). Its
 * check passed against an older base; main moved; a repository that
 * requires checks will not merge it on that green (`checksHold`). The
 * green sweep asks for the check again on the base as it is now, and the
 * fresh green lands it — no person re-queues anything. The tick line's
 * words say how many approved pulls wait, and why.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun, setRunBase } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { lastWaits, tallyWaits, waitWords } from "../src/crew/waits.ts";
import { repoDir } from "../src/git/repos.ts";

describe("a stale green is checked again by the queue", () => {
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

  test("approve a green pull, move main, and it lands with nobody acting", async () => {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: "feature/a",
      base: "main",
      message: "a",
      files: [{ path: "a.ts", content: "export const a = 1;\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, repo, {
      title: "a",
      baseBranch: "main",
      headBranch: "feature/a",
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

    // Main moves past the base the green was checked on.
    const moved = await commitToBranch(app, alice, repo, {
      message: "elsewhere",
      files: [{ path: "b.ts", content: "export const b = 1;\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const before = mainTip();

    // The first sweep does not land on the stale green: it asks again.
    expect(await sweepGreen(app, fresh())).toBe(0);
    expect(asked).toEqual([{ commit: pull.headOid, reason: "stale" }]);
    expect(lastWaits(repo.id)).toEqual({ stale: 1 });
    expect(mainTip()).toBe(before);

    // The fresh green, on main as it is now, lands on the next sweep.
    expect(await sweepGreen(app, fresh())).toBe(1);
    expect(asked).toHaveLength(1);
    const landed = getPull(app.db, repo.id, pull.number)!;
    expect(landed.mergedAt).not.toBeNull();
    expect(mainTip()).not.toBe(before);
  });
});

describe("the tick's words for approved pulls that wait", () => {
  test("say how many, and why, most first", () => {
    expect(waitWords(tallyWaits(["stale", "queued", "stale", "review"]))).toBe(
      "4 approved: stale=2 queued=1 review=1",
    );
  });

  test("say nothing when no approved pull waits", () => {
    expect(waitWords(tallyWaits([]))).toBeUndefined();
  });
});
