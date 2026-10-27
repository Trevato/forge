/**
 * A hold takes a pull out of the merge queue's line (#6611), not just out of
 * the next admission: a pull waiting behind a gate that is then held, closed,
 * pushed to or sent back for changes leaves the line on the next tick, the
 * tick line's waiting count says so, and the next batch is formed without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { queueWords, stopQueue } from "../src/checks/queue.ts";
import { gateRecords } from "../src/checks/queue_store.ts";
import { provideChecksForTest, type ChecksHandle, type GateDone } from "../src/checks/service.ts";
import { setHold } from "../src/core/holds.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { landIfGreen, pruneLine } from "../src/crew/autonomy.ts";

describe("a hold and the merge queue's line", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  /** Gates running on the stand-in lane, by commit: what `adopt` finds. */
  const running = new Map<string, { done: Promise<GateDone>; go: (done: GateDone) => void }>();
  /** Every gate the lane was asked to start, by commit. */
  let started: string[] = [];
  /** The lane lost its runs (the pod went with them): nothing to adopt. */
  let lost = false;


  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-hold-"));
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
    provideChecksForTest(app, {
      gate: (_repo: Repo, _pull: Pull, commitOid: string) => {
        started.push(commitOid);
        let go!: (done: GateDone) => void;
        const done = new Promise<GateDone>((resolve) => (go = resolve));
        running.set(commitOid, { done, go });
        void done.then(() => running.delete(commitOid));
        return done;
      },
      adopt: (commitOid: string) => (lost ? undefined : running.get(commitOid)?.done),
      spareSlots: () => 0,
    } as unknown as ChecksHandle);
  });

  afterAll(async () => {
    stopQueue();
    for (const r of running.values()) r.go({ ok: false, error: "", lines: [], interrupted: true });
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function autonomousRepo(name: string): Promise<Repo> {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        { path: "README.md", content: `# ${name}\n` },
        { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full: "true" } }) },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(made.value.id, alice.id);
    return getRepoById(app.db, made.value.id)!;
  }

  async function greenPull(repo: Repo, path: string): Promise<Pull> {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: `feature/${path}`,
      base: "main",
      message: path,
      files: [{ path, content: `export const n = "${path}";\n` }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, repo, { title: path, baseBranch: "main", headBranch: `feature/${path}` });
    if (!opened.ok) throw new Error(String(opened.error));
    const pull = getPull(app.db, repo.id, opened.value.number)!;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: pull.id,
      env: `pull-${pull.number}`,
      commitOid: pull.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    return pull;
  }

  async function gating(n: number): Promise<void> {
    for (let i = 0; i < 2000 && running.size < n; i++) await Bun.sleep(5);
    expect(running.size).toBe(n);
  }

  /** Each pull joins the line after the one before it has: the order is the test's. */
  async function joinInTurn(repo: Repo, pulls: readonly Pull[]): Promise<Promise<boolean>[]> {
    const landing: Promise<boolean>[] = [];
    for (const [i, pull] of pulls.entries()) {
      landing.push(landIfGreen(app, repo, pull));
      for (let n = 0; n < 4000 && !queueWords(repo.id).includes(`${i + 1} waiting`); n++) await Bun.sleep(5);
      expect(queueWords(repo.id)).toContain(`${i + 1} waiting`);
    }
    return landing;
  }

  test("three pulls wait, the middle one is held: the line says 2 waiting and the next batch has 2", async () => {
    const repo = await autonomousRepo("hold-middle");
    const first = await greenPull(repo, "first.ts");
    const landingFirst = landIfGreen(app, repo, first);
    await gating(1);
    const busy = started.at(-1)!;
    const [a, b, c] = [await greenPull(repo, "a.ts"), await greenPull(repo, "b.ts"), await greenPull(repo, "c.ts")];
    const landing = await joinInTurn(repo, [a, b, c]);
    expect(queueWords(repo.id)).toContain("3 waiting");
    setHold(app.db, b.id, alice.id, "not this one yet");
    expect(pruneLine(app, repo)).toBe(1);
    expect(queueWords(repo.id)).toContain("2 waiting");
    expect(await landing[1]).toBe(false);
    // The gate ahead answers: the next batch is formed of the two left.
    running.get(busy)!.go({ ok: true, error: "", lines: [] });
    expect(await landingFirst).toBe(true);
    await gating(1);
    const [next] = gateRecords(app.db, repo.id);
    expect(next!.steps.map((s) => s.pullId)).toEqual([a.id, c.id]);
    running.get(started.at(-1)!)!.go({ ok: true, error: "", lines: [] });
    expect(await landing[0]).toBe(true);
    expect(await landing[2]).toBe(true);
    expect(getPull(app.db, repo.id, b.number)!.mergedAt).toBeNull();
  }, 60_000);

  test("a pull pushed to or sent back for changes leaves the line; a pull still fit stays", async () => {
    const repo = await autonomousRepo("hold-others");
    const first = await greenPull(repo, "first.ts");
    const landingFirst = landIfGreen(app, repo, first);
    await gating(1);
    const busy = started.at(-1)!;
    const [a, b, c] = [await greenPull(repo, "a.ts"), await greenPull(repo, "b.ts"), await greenPull(repo, "c.ts")];
    const landing = await joinInTurn(repo, [a, b, c]);
    // a is pushed to; c is closed. b stays.
    app.db.query("UPDATE pull SET head_oid = ?2 WHERE issue_id = ?1").run(a.id, "f".repeat(40));
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(c.id);
    expect(pruneLine(app, repo)).toBe(2);
    expect(queueWords(repo.id)).toContain("1 waiting");
    expect(await landing[0]).toBe(false);
    expect(await landing[2]).toBe(false);
    expect(pruneLine(app, repo)).toBe(0);
    running.get(busy)!.go({ ok: true, error: "", lines: [] });
    expect(await landingFirst).toBe(true);
    await gating(1);
    running.get(started.at(-1)!)!.go({ ok: true, error: "", lines: [] });
    expect(await landing[1]).toBe(true);
  }, 60_000);
});
