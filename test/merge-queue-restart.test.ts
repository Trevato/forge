/**
 * The merge queue survives a roll (#6611). A gate's candidate is recorded
 * as it starts; a queue stopped mid-gate and started again resumes that
 * very candidate — the run still going on the check lane adopted, a verdict
 * that came in after the stop acted on, or, the run gone, the same tip
 * gated again on the same base — and never plans the line from nothing.
 * The lane here is a stand-in the test holds open and lets go of.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { beginGate, endGate } from "../src/checks/gate_record.ts";
import { adoptGate } from "../src/checks/landing.ts";
import { type GateRecord, gateRuns, stopQueue } from "../src/checks/queue.ts";
import { beginGateRecord, gateRecords, keepRed, queueStore, redMarks, settleGateRecord } from "../src/checks/queue_store.ts";
import { provideChecksForTest, type ChecksHandle, type GateDone } from "../src/checks/service.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { repoDir } from "../src/git/repos.ts";

describe("the merge queue across a restart", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  /** Gates running on the stand-in lane, by commit: what `adopt` finds. */
  const running = new Map<string, { done: Promise<GateDone>; go: (done: GateDone) => void }>();
  /** Every gate the lane was asked to start, by commit. */
  let started: string[] = [];
  /** The lane lost its runs (the pod went with them): nothing to adopt. */
  let lost = false;

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-restart-"));
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

  /** Three green pulls at the gate as one candidate, recorded; then the queue is killed. */
  async function killedMidGate(name: string) {
    const repo = await autonomousRepo(name);
    const pulls = [await greenPull(repo, "a.ts"), await greenPull(repo, "b.ts"), await greenPull(repo, "c.ts")];
    const base = git(repo, "rev-parse", "main");
    started = [];
    lost = false;
    const first = sweepGreen(app, repo);
    await gating(1);
    const [tip] = started;
    const [record] = gateRecords(app.db, repo.id);
    expect(record).toBeDefined();
    expect(record!.tipOid).toBe(tip!);
    expect(record!.baseOid).toBe(base);
    expect(record!.runId).toBe(`gate-${tip!.slice(0, 12)}`);
    expect(record!.steps.map((s) => s.pullId)).toEqual(pulls.map((p) => p.id));
    stopQueue();
    // What waited on the killed queue is answered: nothing landed.
    expect(await first).toBe(0);
    return { repo, pulls, base, tip: tip!, record: record! };
  }

  const merged = (repo: Repo, pull: Pull) => getPull(app.db, repo.id, pull.number)!.mergedAt !== null;

  test("killed mid-gate and started again, the same candidate lands with no second gate run", async () => {
    const { repo, pulls, base, tip, record } = await killedMidGate("restart-adopt");
    const again = sweepGreen(app, repo);
    // The new line adopts the run still going on the lane: none is started.
    for (let i = 0; i < 20; i++) await Bun.sleep(5);
    expect(started).toEqual([tip]);
    running.get(tip)!.go({ ok: true, error: "", lines: [] });
    expect(await again).toBe(3);
    expect(started).toEqual([tip]);
    expect(gateRuns(repo.id)).toBe(0);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    // Main is exactly the tree that was gated, on the base it was built on.
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(record.treeOid);
    expect(git(repo, "rev-list", "--count", `${base}..main`)).toBe("3");
    expect(gateRecords(app.db, repo.id)).toEqual([]);
  });

  test("a verdict that came in after the stop is acted on, with no gate at all", async () => {
    const { repo, pulls, tip, record } = await killedMidGate("restart-verdict");
    // The stopped forge's gate answers on its drain: kept in the record.
    running.get(tip)!.go({ ok: true, error: "", lines: [] });
    for (let i = 0; i < 200 && gateRecords(app.db, repo.id)[0]?.verdict === undefined; i++) await Bun.sleep(5);
    expect(gateRecords(app.db, repo.id)[0]?.verdict).toEqual({ lands: true });
    lost = true;
    expect(await sweepGreen(app, repo)).toBe(3);
    expect(started).toEqual([tip]);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(record.treeOid);
  });

  test("the run gone, the same candidate is gated again on the same base, not planned again", async () => {
    const { repo, pulls, tip, record } = await killedMidGate("restart-regate");
    // The forge stopping cut its gate off: no verdict, and the record stays.
    running.get(tip)!.go({ ok: false, error: "cut off", lines: [], interrupted: true });
    await Bun.sleep(20);
    expect(gateRecords(app.db, repo.id).map((r) => r.id)).toEqual([record.id]);
    lost = true;
    const again = sweepGreen(app, repo);
    await gating(1);
    // The very commit that was gated before, not a candidate built anew.
    expect(started).toEqual([tip, tip]);
    running.get(tip)!.go({ ok: true, error: "", lines: [] });
    expect(await again).toBe(3);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(record.treeOid);
  });

  test("a red (check) the stopped forge's gate came back with is gated once more as the same candidate, nothing searched (#6722)", async () => {
    const { repo, pulls, tip, record } = await killedMidGate("restart-red-check");
    // The roll's drain answers red with no test named: kept, not acted on.
    running.get(tip)!.go({ ok: false, error: "check exited with code 1", lines: [], stage: "check" });
    for (let i = 0; i < 200 && gateRecords(app.db, repo.id)[0]?.verdict === undefined; i++) await Bun.sleep(5);
    expect(gateRecords(app.db, repo.id)[0]?.verdict).toMatchObject({ lands: false, reason: { kind: "check" } });
    lost = true;
    const again = sweepGreen(app, repo);
    await gating(1);
    // The very commit that was gated before, gated once more before any search.
    expect(started).toEqual([tip, tip]);
    running.get(tip)!.go({ ok: true, error: "", lines: [] });
    expect(await again).toBe(3);
    expect(started).toEqual([tip, tip]);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(record.treeOid);
    expect(redMarks(app.db, repo.id).size).toBe(0);
  });

  test("a recorded candidate whose base moved is forgotten, and the line is planned afresh", async () => {
    const { repo, pulls, tip } = await killedMidGate("restart-moved");
    running.get(tip)!.go({ ok: false, error: "cut off", lines: [], interrupted: true });
    const moved = await commitToBranch(app, alice, repo, {
      message: "main moves",
      files: [{ path: "other.ts", content: "export {};\n" }],
    });
    if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    const again = sweepGreen(app, repo);
    await gating(1);
    expect(started).toHaveLength(2);
    expect(started[1]).not.toBe(tip);
    running.get(started[1]!)!.go({ ok: true, error: "", lines: [] });
    expect(await again).toBe(3);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(gateRecords(app.db, repo.id)).toEqual([]);
  });

  test("red marks are kept by pull, head and base, one per pull, and read back", async () => {
    const repo = await autonomousRepo("restart-reds");
    const pull = await greenPull(repo, "r.ts");
    const head = pull.headOid;
    const base = git(repo, "rev-parse", "main");
    const store = queueStore(app.db);
    store.red(repo.id, pull.id, { head, base, together: [4, 5], at: 1000 });
    expect(redMarks(app.db, repo.id).get(pull.id)).toEqual({ head, base, together: [4, 5], at: 1000 });
    // A new mark replaces the old: the line remembers one per pull.
    keepRed(app.db, repo.id, pull.id, { head, base: head, together: [], at: 2000 });
    expect([...redMarks(app.db, repo.id).values()]).toEqual([{ head, base: head, together: [], at: 2000 }]);
    store.red(repo.id, pull.id, undefined);
    expect(redMarks(app.db, repo.id).size).toBe(0);
  });

  test("a record that does not read is no record", async () => {
    const repo = await autonomousRepo("restart-garbage");
    app.db
      .query(
        `INSERT INTO queue_gate (id, repo_id, run_id, base_oid, base_tree_oid, tip_oid, tree_oid, steps, started_at)
         VALUES ('x', ?1, 'gate-x', 'nope', 'nope', 'nope', 'nope', '{', ?2)`,
      )
      .run(repo.id, new Date().toISOString());
    expect(gateRecords(app.db, repo.id)).toEqual([]);
  });

  test("a red kept across a roll keeps why it went red (#5276): an install red is not searched as the code's", async () => {
    const repo = await autonomousRepo("restart-reason");
    const pull = await greenPull(repo, "w.ts");
    const base = git(repo, "rev-parse", "main");
    const tree = git(repo, "rev-parse", "main^{tree}");
    const tip = pull.headOid;
    beginGateRecord(app.db, {
      id: "reasoned-gate",
      repoId: repo.id,
      runId: `gate-${tip.slice(0, 12)}`,
      baseOid: base,
      baseTreeOid: tree,
      tipOid: tip,
      treeOid: tree,
      steps: [{ pullId: pull.id, headOid: tip, baseOid: base, treeOid: tree, commitOid: tip }],
      startedAt: new Date().toISOString(),
    });
    const red = { lands: false, reopen: true, comment: "red", learn: [], reason: { kind: "install" } } as const;
    settleGateRecord(app.db, "reasoned-gate", red);
    expect(gateRecords(app.db, repo.id)[0]?.verdict).toEqual(red);
    app.db.query("DELETE FROM queue_gate WHERE id = 'reasoned-gate'").run();
  });
  test("a gate the forge before this one still runs is waited on: its verdict comes into the record", async () => {
    const repo = await autonomousRepo("restart-draining");
    const pull = await greenPull(repo, "d.ts");
    const base = git(repo, "rev-parse", "main");
    const tree = git(repo, "rev-parse", "main^{tree}");
    const tip = pull.headOid;
    const record: GateRecord = {
      id: "draining-gate",
      repoId: repo.id,
      runId: `gate-${tip.slice(0, 12)}`,
      baseOid: base,
      baseTreeOid: tree,
      tipOid: tip,
      treeOid: tree,
      steps: [{ pullId: pull.id, headOid: tip, baseOid: base, treeOid: tree, commitOid: tip }],
      startedAt: new Date().toISOString(),
    };
    beginGateRecord(app.db, record);
    // No run of it on this lane, and no trace of one anywhere: gone.
    expect(await adoptGate(app, repo, record, new AbortController().signal, 5)).toBeUndefined();
    // The other forge's lane holds it open; its verdict arrives in the record.
    const trace = beginGate(app.db, repo.id, pull.id, tip);
    const waited = adoptGate(app, repo, record, new AbortController().signal, 5);
    await Bun.sleep(30);
    settleGateRecord(app.db, record.id, { lands: true });
    endGate(app.db, trace);
    expect(await waited).toEqual({ lands: true });
    // Its trace closed with no verdict: the run is gone.
    const cut = beginGate(app.db, repo.id, pull.id, tip);
    app.db.query("UPDATE queue_gate SET verdict = NULL WHERE id = ?1").run(record.id);
    const gone = adoptGate(app, repo, record, new AbortController().signal, 5);
    await Bun.sleep(20);
    endGate(app.db, cut);
    expect(await gone).toBeUndefined();
    // The other forge's queue was not stopped: it acted on the verdict and
    // forgot the record. Nothing is told here, and nothing gated again.
    const live = beginGate(app.db, repo.id, pull.id, tip);
    const elsewhere = adoptGate(app, repo, record, new AbortController().signal, 5);
    queueStore(app.db).forget(record.id);
    endGate(app.db, live);
    expect(await elsewhere).toEqual({ lands: false, interrupted: true });
  });
});
