/**
 * The proof before the line (#7616). A pull whose own check was the fast
 * tier joins the merge queue only once the full suite is green on its head
 * squashed onto main. The lane here is a stand-in: its proof goes red on a
 * tree holding a `breaks-*` file (a test the pull's change never reached),
 * and its gate counts the candidates it was asked about.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import {
  keepProof,
  landingsSince,
  proofOf,
  proofRedWords,
  proofsInFlight,
  RED_PROOF_RETRY_MS,
  resetProofsForTest,
  STALE_LANDINGS,
  standing,
  startProof,
  WAIT_MERGE,
  WAIT_SLOT,
} from "../src/checks/proof.ts";
import { enqueue, type Queued } from "../src/checks/queue.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { landVerdict, type LandVerdict } from "../src/checks/tiers.ts";
import { listComments } from "../src/core/issues.ts";
import { openProofRun } from "../src/core/proof_runs.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { listRuns } from "../src/core/runs.ts";
import { nextActor, proofWords } from "../src/flow/next_actor.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen, toldWhileOpen } from "../src/crew/autonomy.ts";
import { mergePull } from "../src/actions/pulls.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { repoDir } from "../src/git/repos.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

/** A loaded check machine runs git eight times slower: the clock must not decide the verdict. */
const SLOW = 120_000;

describe("the proof before the merge queue", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let level: ReturnType<typeof logLevel>;
  /** Every proof the lane ran, and every candidate it gated. */
  const proved: { repo: string; commit: string; ok: boolean }[] = [];
  const gated: { repo: string; commit: string }[] = [];

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    level = logLevel();
    setLogLevel("error");
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-proof-"));
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
      gate: async (repo: Repo, _pull: Pull, commitOid: string) => {
        gated.push({ repo: repo.id, commit: commitOid });
        return { ok: true, error: "", lines: [] };
      },
      prove: async (repo: Repo, _pull: Pull, commitOid: string) => {
        const files = git(repo, "ls-tree", "-r", "--name-only", commitOid).split("\n");
        const ok = !files.some((f) => f.startsWith("breaks-"));
        proved.push({ repo: repo.id, commit: commitOid, ok });
        return ok
          ? { ok, error: "", lines: [] }
          : { ok, error: "red", lines: ["test/unrelated.test.ts:", "(fail) unrelated > still works [1.00ms]"] };
      },
      spareSlots: () => 0,
    } as unknown as ChecksHandle);
  });

  afterAll(async () => {
    resetProofsForTest();
    setLogLevel(level);
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function autonomousRepo(name: string, autonomous = true): Promise<Repo> {
    const made = await createRepo(app, alice, { name, visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const seeded = await commitToBranch(app, alice, made.value, {
      message: "Start",
      files: [
        { path: "README.md", content: `# ${name}\n` },
        { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true" } }) },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    if (autonomous) app.db.query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1").run(made.value.id, alice.id);
    return getRepoById(app.db, made.value.id)!;
  }

  /** A pull whose own (fast) check passed on its head. */
  async function greenPull(repo: Repo, path: string, content = `export const n = "${path}";\n`): Promise<Pull> {
    const pushed = await commitToBranch(app, alice, repo, {
      branch: `feature/${path}`,
      base: "main",
      message: path,
      files: [{ path, content }],
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

  const merged = (repo: Repo, pull: Pull) => getPull(app.db, repo.id, pull.number)!.mergedAt !== null;
  const tree = (repo: Repo, rev: string) => git(repo, "rev-parse", `${rev}^{tree}`);
  const mainOf = (repo: Repo) => git(repo, "rev-parse", "refs/heads/main");
  const until = async (ok: () => boolean): Promise<void> => {
    for (const end = Date.now() + SLOW; !ok() && Date.now() < end; ) await Bun.sleep(5);
  };

  test("a pull that breaks an unrelated test is never admitted, and is told the test by name", async () => {
    const repo = await autonomousRepo("breaks-unrelated");
    const pull = await greenPull(repo, "breaks-other.ts");
    expect(await sweepGreen(app, repo)).toBe(0);
    await until(() => proofOf(app.db, pull.id) !== undefined);
    // Proved on its head squashed onto main, red, and nothing reached the gate.
    expect(proved.filter((p) => p.repo === repo.id)).toHaveLength(1);
    const [proof] = proved.filter((p) => p.repo === repo.id);
    expect(git(repo, "rev-parse", `${proof!.commit}^`)).toBe(mainOf(repo));
    expect(proofOf(app.db, pull.id)).toMatchObject({ head: pull.headOid, base: mainOf(repo), green: false });
    await until(() => listComments(app.db, pull.id).length > 0);
    const told = listComments(app.db, pull.id).map((c) => c.body).join("\n");
    expect(told).toContain("has not joined the merge queue");
    expect(told).toContain("- unrelated > still works");
    // The next sweep neither admits it nor proves the same head again.
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(proved.filter((p) => p.repo === repo.id)).toHaveLength(1);
    expect(gated.filter((g) => g.repo === repo.id)).toHaveLength(0);
    expect(merged(repo, pull)).toBe(false);
  });

  test("a green proof admits the pull, which lands on the tree it was proved on", async () => {
    const repo = await autonomousRepo("proved-green");
    const pull = await greenPull(repo, "fine.ts");
    // Not admitted on its fast check alone: proved first, beside the sweep.
    expect(await sweepGreen(app, repo)).toBe(0);
    await until(() => merged(repo, pull));
    expect(merged(repo, pull)).toBe(true);
    const proofs = proved.filter((p) => p.repo === repo.id);
    expect(proofs).toHaveLength(1);
    expect(tree(repo, "refs/heads/main")).toBe(tree(repo, proofs[0]!.commit));
    expect(gated.filter((g) => g.repo === repo.id)).toHaveLength(1);
  });

  test("a proof main has moved too far past is proved again on the new main before it joins", async () => {
    const repo = await autonomousRepo("proof-stale");
    const pull = await greenPull(repo, "late.ts");
    const old = mainOf(repo);
    keepProof(app.db, repo.id, pull.id, { head: pull.headOid, base: old, green: true });
    for (let i = 0; i <= STALE_LANDINGS; i++) {
      const moved = await commitToBranch(app, alice, repo, {
        message: `landing ${i}`,
        files: [{ path: `main-${i}.ts`, content: `${i}\n` }],
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    }
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    expect(await landingsSince(dir, old, mainOf(repo))).toBe(STALE_LANDINGS + 1);
    const now = mainOf(repo);
    expect(await sweepGreen(app, repo)).toBe(0);
    await until(() => merged(repo, pull));
    expect(merged(repo, pull)).toBe(true);
    const proofs = proved.filter((p) => p.repo === repo.id);
    expect(proofs).toHaveLength(1);
    expect(git(repo, "rev-parse", `${proofs[0]!.commit}^`)).toBe(now);
  });

  test("an admitted pull whose proof went stale in the line is left out of its batch, unrun", async () => {
    const repo = await autonomousRepo("stale-in-line");
    const pulls = [await greenPull(repo, "ok.ts"), await greenPull(repo, "stale.ts")];
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const asked: string[] = [];
    const entries: Queued[] = pulls.map((pull, i) => ({
      pull,
      dir,
      land: async () => undefined,
      release: () => {},
      handBack: () => {},
      proven: async (base) => {
        asked.push(base);
        return i === 0;
      },
    }));
    const steps: number[][] = [];
    const answers = await enqueue(repo.id, entries, async (candidate) => {
      steps.push(candidate.steps.map((s) => s.entry.pull.number));
      return { lands: true };
    });
    expect(answers).toEqual([false, false]);
    // The stale one never reached a gate; the fresh one gated alone.
    expect(steps).toEqual([[pulls[0]!.number]]);
    expect(asked.length).toBeGreaterThanOrEqual(2);
  });

  test("a red proof's words name the base, every failing test and the log", () => {
    const red = landVerdict(false, ["a > b"], ["test/a.test.ts"], "/api/v1/repos/o/r/gates/x/log", undefined, {
      passed: 9,
      failed: 3,
      failing: [
        { name: "a > b", errors: [] },
        { name: "c", errors: [] },
      ],
    });
    if (red.lands) throw new Error("green");
    const words = proofRedWords("main", "0123456789abcdef", red);
    expect(words).toContain("squashed onto main (0123456)");
    expect(words).toContain("- a > b\n- c\n- and 1 more");
    expect(words).toContain("The gate's log: /api/v1/repos/o/r/gates/x/log");
  });

  test("a proof that never answers is cut off at its deadline: its slot and its pull are let go, no verdict kept", async () => {
    const repo = await autonomousRepo("proof-hangs", false);
    const pull = await greenPull(repo, "hang.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = mainOf(repo);
    let aborted: AbortSignal | undefined;
    let answered = false;
    const started = await startProof({
      db: app.db,
      repoId: repo.id,
      pull,
      dir,
      tip,
      // Hung: answers only once its signal aborts, and then too late to count.
      run: (_commit, signal) =>
        new Promise((resolve) => {
          aborted = signal;
          signal.addEventListener("abort", () => setTimeout(() => resolve({ lands: true }), 50), { once: true });
        }),
      room: () => 0,
      done: () => {
        answered = true;
      },
      deadlineMs: 100,
    });
    expect(started).toBe(true);
    // Running: it holds a slot, and the pull stands `proving`.
    expect(proofsInFlight()).toBe(1);
    expect(await standing(app.db, dir, pull, tip)).toBe("proving");
    await until(() => proofsInFlight() === 0);
    expect(aborted?.aborted).toBe(true);
    expect(proofsInFlight()).toBe(0);
    expect(await standing(app.db, dir, pull, tip)).toBe("unproved");
    await Bun.sleep(100);
    expect(answered).toBe(false);
    expect(proofOf(app.db, pull.id)).toBeUndefined();
  });

  test("a red proof stands only on the main it ran on, and only for a while", async () => {
    const repo = await autonomousRepo("proof-red-retry", false);
    const pull = await greenPull(repo, "red.txt", "red\n");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = mainOf(repo);
    keepProof(app.db, repo.id, pull.id, { head: pull.headOid, base: tip, green: false });
    expect(await standing(app.db, dir, pull, tip)).toBe("red");
    expect(await standing(app.db, dir, pull, tip, Date.now() + RED_PROOF_RETRY_MS + 1000)).toBe("unproved");
    const moved = await commitToBranch(app, alice, repo, { message: "on", files: [{ path: "on.txt", content: "on\n" }] });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    expect(await standing(app.db, dir, pull, mainOf(repo))).toBe("unproved");
  });

  test("a head that does not merge onto the tip is not proved, and holds no slot", async () => {
    const repo = await autonomousRepo("proof-conflict", false);
    const pull = await greenPull(repo, "README.md", "# theirs\n");
    const moved = await commitToBranch(app, alice, repo, { message: "ours", files: [{ path: "README.md", content: "# ours\n" }] });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    let ran = false;
    const started = await startProof({
      db: app.db,
      repoId: repo.id,
      pull,
      dir,
      tip: mainOf(repo),
      run: async () => {
        ran = true;
        return { lands: true };
      },
      room: () => 1,
      done: () => {},
    });
    expect(started).toBe(false);
    expect(ran).toBe(false);
    expect(proofsInFlight()).toBe(0);
    expect(await standing(app.db, dir, pull, mainOf(repo))).toBe("unproved");
  });

  test("a proof waits while every check slot is taken, says so once, and starts when one frees", async () => {
    const repo = await autonomousRepo("proof-slots", false);
    const first = await greenPull(repo, "one.ts");
    const second = await greenPull(repo, "two.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = mainOf(repo);
    let release: (v: LandVerdict) => void = () => {};
    expect(
      await startProof({
        db: app.db, repoId: repo.id, pull: first, dir, tip, room: () => 1, done: () => {},
        run: () => new Promise<LandVerdict>((resolve) => (release = resolve)),
      }),
    ).toBe(true);
    const told: string[] = [];
    let free = 0;
    const again = () =>
      startProof({
        db: app.db, repoId: repo.id, pull: second, dir, tip, room: () => free, done: () => {},
        told: (w) => told.push(w), run: async () => ({ lands: true }),
      });
    expect(await again()).toBe(false);
    expect(await again()).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("no check slot is spare");
    const waiting = listRuns(app.db, repo.id, { kind: "proof", issueId: second.id });
    expect(waiting).toHaveLength(1);
    expect(waiting[0]!.state).toBe("queued");
    release({ lands: true });
    await until(() => proofsInFlight() === 0);
    free = 1;
    expect(await again()).toBe(true);
    await until(() => proofsInFlight() === 0);
    const ran = listRuns(app.db, repo.id, { kind: "proof", issueId: second.id });
    expect(ran).toHaveLength(1);
    expect(ran[0]!.id).toBe(waiting[0]!.id);
    expect(ran[0]!.state).toBe("ok");
    // The runs list carries proofs among the rest.
    expect(listRuns(app.db, repo.id, { withProofs: true }).some((r) => r.kind === "proof")).toBe(true);
  });

  test("a head that does not merge says so on the pull once, and its next names the wait", async () => {
    const repo = await autonomousRepo("proof-says", false);
    const pull = await greenPull(repo, "README.md", "# theirs\n");
    const moved = await commitToBranch(app, alice, repo, { message: "ours", files: [{ path: "README.md", content: "# ours\n" }] });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const told: string[] = [];
    const go = () =>
      startProof({
        db: app.db, repoId: repo.id, pull, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        told: (w) => told.push(w), run: async () => ({ lands: true }),
      });
    expect(await go()).toBe(false);
    expect(await go()).toBe(false);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("does not merge");
    const run = listRuns(app.db, repo.id, { kind: "proof" })[0]!;
    expect(run.state).toBe("failed");
    expect(proofWords(app.db, pull, pull.headOid)).toBe(WAIT_MERGE);
    expect(
      nextActor({ held: null, conflicted: false, check: "ok", changesRequested: 0, approvals: 1, pushedSince: 0, proof: "cannot start: the head does not merge onto the base tip" }).why,
    ).toContain("its proof cannot start");
  });

  test("a proof cut off leaves a cut-off run and a comment, and is proved again", async () => {
    const repo = await autonomousRepo("proof-cut", false);
    const pull = await greenPull(repo, "cut.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const tip = mainOf(repo);
    const told: string[] = [];
    const go = (run: () => Promise<LandVerdict>, deadlineMs?: number) =>
      startProof({
        db: app.db, repoId: repo.id, pull, dir, tip, room: () => 1, done: () => {},
        told: (w) => told.push(w), run, ...(deadlineMs === undefined ? {} : { deadlineMs }),
      });
    expect(await go(() => new Promise(() => {}), 50)).toBe(true);
    await until(() => proofsInFlight() === 0);
    const cut = listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id })[0]!;
    expect(cut.state).toBe("cancelled");
    expect(cut.summary).toContain("deadline");
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("cut off");
    expect(proofWords(app.db, pull, pull.headOid)).toBe("was cut off: at the deadline; it is proved again on the next sweep");
    // The next sweep proves it again.
    expect(await go(async () => ({ lands: true }))).toBe(true);
    await until(() => proofsInFlight() === 0);
    expect(listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id })[0]!.state).toBe("ok");
  });

  test("a proof cut off twice on one head tells the pull once", async () => {
    const repo = await autonomousRepo("proof-cut-twice", false);
    const pull = await greenPull(repo, "twice.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const told: string[] = [];
    const go = () =>
      startProof({
        db: app.db, repoId: repo.id, pull, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        told: (w) => told.push(w), run: () => new Promise(() => {}), deadlineMs: 30,
      });
    expect(await go()).toBe(true);
    await until(() => proofsInFlight() === 0);
    expect(await go()).toBe(true);
    await until(() => proofsInFlight() === 0);
    const runs = listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id });
    expect(runs.map((r) => r.state)).toEqual(["cancelled", "cancelled"]);
    expect(told).toHaveLength(1);
  });

  test("a push ends the old head's waiting proof as superseded", async () => {
    const repo = await autonomousRepo("proof-superseded", false);
    const first = await greenPull(repo, "super.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    let release: (v: LandVerdict) => void = () => {};
    const other = await greenPull(repo, "other.ts");
    expect(
      await startProof({
        db: app.db, repoId: repo.id, pull: other, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        run: () => new Promise<LandVerdict>((resolve) => (release = resolve)),
      }),
    ).toBe(true);
    const wait = () =>
      startProof({ db: app.db, repoId: repo.id, pull: getPull(app.db, repo.id, first.number)!, dir, tip: mainOf(repo), room: () => 0, done: () => {}, run: async () => ({ lands: true }) });
    expect(await wait()).toBe(false);
    const queued = listRuns(app.db, repo.id, { kind: "proof", issueId: first.id });
    expect(queued.map((r) => r.state)).toEqual(["queued"]);
    const pushed = await commitToBranch(app, alice, repo, {
      branch: "feature/super.ts", base: "main", message: "more", files: [{ path: "more.ts", content: "export const m = 1;\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    expect(await wait()).toBe(false);
    const after = listRuns(app.db, repo.id, { kind: "proof", issueId: first.id });
    expect(after.map((r) => [r.state, r.summary])).toEqual([
      ["queued", "no check slot is spare"],
      ["cancelled", "superseded by a push"],
    ]);
    expect(after[0]!.commitOid).not.toBe(queued[0]!.commitOid);
    release({ lands: true });
    await until(() => proofsInFlight() === 0);
  });

  test("a proof a restart left running is cut off and told, then proved again", async () => {
    const repo = await autonomousRepo("proof-restart", false);
    const pull = await greenPull(repo, "restart.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    openProofRun(app.db, { repoId: repo.id, pullId: pull.id, head: pull.headOid, base: "", state: "running", summary: "" });
    const told: string[] = [];
    expect(
      await startProof({
        db: app.db, repoId: repo.id, pull, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        told: (w) => told.push(w), run: async () => ({ lands: true }),
      }),
    ).toBe(true);
    await until(() => proofsInFlight() === 0);
    const runs = listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id });
    expect(runs.map((r) => r.state)).toEqual(["ok", "cancelled"]);
    expect(told[0]).toContain("the forge stopped");
  });

  test("a gate that fails to answer cuts the proof off and tells the pull once", async () => {
    const repo = await autonomousRepo("proof-throws", false);
    const pull = await greenPull(repo, "throws.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const told: string[] = [];
    const go = () =>
      startProof({
        db: app.db, repoId: repo.id, pull, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        told: (w) => told.push(w), run: () => Promise.reject(new Error("no gate")),
      });
    expect(await go()).toBe(true);
    await until(() => proofsInFlight() === 0);
    expect(await go()).toBe(true);
    await until(() => proofsInFlight() === 0);
    const runs = listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id });
    expect(runs.map((r) => [r.state, r.summary])).toEqual([
      ["cancelled", "cut off: the gate failed to answer"],
      ["cancelled", "cut off: the gate failed to answer"],
    ]);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain("the gate failed to answer");
  });

  test("a head that cannot merge, then waits for a slot, then cannot merge is told each reason once", async () => {
    const repo = await autonomousRepo("proof-says-once", false);
    const pull = await greenPull(repo, "README.md", "# theirs\n");
    const moved = await commitToBranch(app, alice, repo, { message: "ours", files: [{ path: "README.md", content: "# ours\n" }] });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const other = await greenPull(repo, "busy.ts");
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const told: string[] = [];
    const go = (room: number) =>
      startProof({
        db: app.db, repoId: repo.id, pull, dir, tip: mainOf(repo), room: () => room, done: () => {},
        told: (w) => told.push(w), run: async () => ({ lands: true }),
      });
    expect(await go(1)).toBe(false);
    let release: (v: LandVerdict) => void = () => {};
    expect(
      await startProof({
        db: app.db, repoId: repo.id, pull: other, dir, tip: mainOf(repo), room: () => 1, done: () => {},
        run: () => new Promise<LandVerdict>((resolve) => (release = resolve)),
      }),
    ).toBe(true);
    expect(await go(0)).toBe(false);
    release({ lands: true });
    await until(() => proofsInFlight() === 0);
    expect(await go(1)).toBe(false);
    expect(told).toHaveLength(2);
    expect(told[0]).toContain("does not merge");
    expect(told[1]).toContain("no check slot is spare");
    expect(listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id }).map((r) => r.state)).toEqual(["failed", "failed"]);
  });

  for (const ending of ["merge", "close"] as const)
    test(`${ending === "merge" ? "landing" : "closing"} a pull ends its waiting proof`, async () => {
      const repo = await autonomousRepo(`proof-${ending}-ends`, false);
      const pull = await greenPull(repo, `${ending}-ends.ts`);
      openProofRun(app.db, { repoId: repo.id, pullId: pull.id, head: pull.headOid, base: "", state: "queued", summary: WAIT_SLOT });
      if (ending === "merge") {
        const landed = await mergePull(app, alice, repo, pull, "merge");
        if (!landed.ok) throw new Error(String(landed.error));
      } else {
        const closed = setIssueState(app, alice, repo, pull, "closed");
        if (!closed.ok) throw new Error(String(closed.error));
      }
      const runs = listRuns(app.db, repo.id, { kind: "proof", issueId: pull.id });
      expect(runs.map((r) => [r.state, r.summary])).toEqual([["cancelled", ending === "merge" ? "pull landed" : "pull closed"]]);
    });

  test("a proof's words reach the pull only while it is open on the head proved", async () => {
    const repo = await autonomousRepo("proof-told-guard", false);
    const pull = await greenPull(repo, "guard.ts");
    const said = () => listComments(app.db, pull.id).filter((c) => c.body.startsWith("guard:")).length;
    toldWhileOpen(app, repo, alice, pull)("guard: current");
    expect(said()).toBe(1);
    const pushed = await commitToBranch(app, alice, repo, {
      branch: "feature/guard.ts", base: "main", message: "more", files: [{ path: "guard2.ts", content: "export const g = 2;\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    toldWhileOpen(app, repo, alice, pull)("guard: stale head");
    expect(said()).toBe(1);
    const now = getPull(app.db, repo.id, pull.number)!;
    const closed = setIssueState(app, alice, repo, now, "closed");
    if (!closed.ok) throw new Error(String(closed.error));
    toldWhileOpen(app, repo, alice, now)("guard: closed");
    expect(said()).toBe(1);
  });
});
