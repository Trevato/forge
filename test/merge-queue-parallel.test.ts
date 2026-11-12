/**
 * The merge queue gates in parallel where check slots are free (#4053).
 * While one candidate gates on main the next gates on top of it, and lands
 * right after it; a red candidate's prefixes gate at once, so the culprit
 * is found in one gate-time, not one per halving. The gate here is a
 * stand-in the test holds open: it lets a whole wave go only once every
 * gate the wave should hold has started, so "at once" is counted, never
 * timed. It goes red on any tree holding a `red-*` file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { enqueue, extraGates, gateRuns, queueStatus, queueWords } from "../src/checks/queue.ts";
import { PULL_RESERVE, provideChecksForTest, startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { latestDecision } from "../src/core/decisions.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { readQueues } from "../src/flow/queue.ts";
import { repoDir } from "../src/git/repos.ts";
import { flowLines } from "../src/tui/screens/flow.ts";
import { serve, type Servers } from "../src/http/server.ts";

/** Check slots the stand-in service has. */
const CAPACITY = 12;

describe("the merge queue in parallel", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;
  /** Gates started and not yet let go. */
  let pending: { commit: string; go: () => void }[] = [];
  /** Every gate, with its verdict and the wave it was let go in. */
  const gated: { repo: string; commit: string; ok: boolean; wave: number }[] = [];
  let wave = 0;

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-parallel-"));
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
        await new Promise<void>((go) => pending.push({ commit: commitOid, go }));
        const files = git(repo, "ls-tree", "-r", "--name-only", commitOid).split("\n");
        const ok = !files.some((f) => f.startsWith("red-"));
        gated.push({ repo: repo.id, commit: commitOid, ok, wave });
        return ok ? { ok, error: "", lines: [] } : { ok, error: "red", lines: ["test/red.test.ts:", "(fail) goes red [1.00ms]"] };
      },
      // Nothing else runs: every slot but the pull checks' reserve is free.
      spareSlots: () => Math.max(0, CAPACITY - PULL_RESERVE - extraGates()),
    } as unknown as ChecksHandle);
    servers = await serve(app);
  });

  afterAll(async () => {
    servers.stop();
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

  /** Wait until `n` gates are open at once, then let them all go: one wave. */
  async function letGo(n: number): Promise<void> {
    for (let i = 0; i < 2000 && pending.length < n; i++) await Bun.sleep(5);
    expect(pending).toHaveLength(n);
    wave++;
    const going = pending;
    pending = [];
    for (const p of going) p.go();
  }

  const merged = (repo: Repo, pull: Pull) => getPull(app.db, repo.id, pull.number)!.mergedAt !== null;
  const tree = (repo: Repo, rev: string) => git(repo, "rev-parse", `${rev}^{tree}`);

  test("sixteen green pulls: two candidates gate at once, the second on the first, and both land in one gate-time", async () => {
    const repo = await autonomousRepo("sixteen-green");
    const pulls = [];
    for (let i = 0; i < 16; i++) pulls.push(await greenPull(repo, `p${i}.ts`));
    const sweep = sweepGreen(app, repo);
    for (let i = 0; i < 2000 && pending.length < 2; i++) await Bun.sleep(5);
    expect(queueStatus().find((s) => s.repoId === repo.id)).toMatchObject({ gating: 16, gates: 2, queued: 0 });
    expect(queueWords(repo.id)).toMatch(/^gating 16 pulls since \d\d:\d\d in 2 gates$/);
    await letGo(2);
    expect(await sweep).toBe(16);
    expect(gateRuns(repo.id)).toBe(2);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    // Main is exactly the tree the second candidate was gated on.
    const mine = gated.filter((g) => g.repo === repo.id);
    expect(mine.every((g) => g.ok && g.wave === wave)).toBe(true);
    expect(mine.map((g) => tree(repo, g.commit))).toContain(tree(repo, "refs/heads/main"));
    expect(git(repo, "rev-list", "--count", "refs/heads/main")).toBe("17");
  });

  test("ten pulls, one red: the head is gated alone, the culprit is found in one wave of stacked prefixes, and the nine land by the fourth gate-time", async () => {
    const repo = await autonomousRepo("ten-one-red");
    const pulls = [];
    for (let i = 0; i < 10; i++) pulls.push(await greenPull(repo, i === 4 ? `red-${i}.ts` : `p${i}.ts`));
    const first = wave;
    const sweep = sweepGreen(app, repo);
    // Wave one: eight on main, the other two on top of them.
    await letGo(2);
    // Wave two: the eight are red, so their head is gated alone (#4999),
    // beside the other seven and the next on main and the last on top.
    await letGo(3);
    // Wave three: the head was green alone; the eight without it are red
    // again, and are searched by prefixes of their own chain, each on the
    // one before (#5994): the first red one names the culprit, the green
    // one before it lands, and the culprit is handed back with no gate more.
    await letGo(7);
    // Wave four: the pulls after the culprit, with the head, are one candidate.
    await letGo(1);
    expect(await sweep).toBe(9);
    expect(wave - first).toBe(4);
    const red = pulls[4]!;
    for (const pull of pulls) expect(merged(repo, pull)).toBe(pull !== red);
    expect(latestDecision(app.db, red.id, "land")?.answer).toBe("red");
    expect(git(repo, "ls-tree", "--name-only", "refs/heads/main")).not.toContain("red-4.ts");
    const green = gated.filter((g) => g.repo === repo.id && g.ok).map((g) => tree(repo, g.commit));
    expect(green).toContain(tree(repo, "refs/heads/main"));
  });

  test("a red second candidate does not hold back the green first, and is searched on main once the first landed", async () => {
    const repo = await autonomousRepo("red-behind");
    const pulls = [];
    for (let i = 0; i < 10; i++) pulls.push(await greenPull(repo, i === 9 ? `red-${i}.ts` : `p${i}.ts`));
    const sweep = sweepGreen(app, repo);
    await letGo(2);
    // The first eight landed; the two behind are red on them, so the first
    // of the two is gated alone on main: green, it lands, and the culprit,
    // red on top of it, is handed back with no gate more (#5994).
    await letGo(1);
    expect(await sweep).toBe(9);
    for (const pull of pulls.slice(0, 9)) expect(merged(repo, pull)).toBe(true);
    expect(merged(repo, pulls[9]!)).toBe(false);
    expect(latestDecision(app.db, pulls[9]!.id, "land")?.answer).toBe("red");
  });

  test("/boards shows the gates in flight and the minutes from approval to landing", async () => {
    const repo = await autonomousRepo("on-boards");
    const pull = await greenPull(repo, "a.ts");
    submitReview(app.db, {
      issueId: pull.id,
      authorId: alice.id,
      state: "approved",
      commitOid: pull.headOid,
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
    });
    const sweep = sweepGreen(app, repo);
    await letGo(1);
    expect(await sweep).toBe(1);
    const row = readQueues(app.db, new Date()).find((r) => r.repo === `alice/${repo.name}`);
    expect(row).toMatchObject({ queued: 0, gating: 0, gates: 0, landedHour: 1, approvedToLanded: 12 });
    // The terminal's Flow dialog says the same as the page.
    const line = flowLines(app.db).find((l) => l.startsWith(`alice/${repo.name} `));
    expect(line?.split(/\s+/)).toEqual([`alice/${repo.name}`, "0", "0", "0", "1", "12"]);
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie } })).text();
    expect(page).toMatch(
      /data-queue="alice\/on-boards">[\s\S]*?data-gates>0<[\s\S]*?data-landed>1<[\s\S]*?data-approved-to-landed>12 min</,
    );
  });
});

describe("the queue's extra gates and the pull checks' slots", () => {
  let dataDir: string;
  let dir: string;
  let app: App;
  let checks: ChecksHandle | undefined;
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-slots-"));
    app = createApp({ dataDir, port: 0 });
    dir = join(dataDir, "line.git");
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
  });

  afterAll(async () => {
    await checks?.stop({ drain: false });
    await app.close?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A pull's head: one file added on main. */
  async function headAdding(name: string): Promise<string> {
    git("checkout", "-q", "-B", name, "main");
    await Bun.write(join(dir, `${name}.txt`), `${name}\n`);
    git("add", `${name}.txt`);
    git("commit", "-q", "-m", name);
    git("checkout", "-q", "main");
    return git("rev-parse", name);
  }

  /**
   * One pull joins and gates; a second joins while the gate is held. How
   * many gates were open at once, and the spare slots each gate saw.
   */
  async function gatesAtOnce(concurrency: number): Promise<{ most: number; spare: number[] }> {
    await checks?.stop({ drain: false });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency });
    const handle = checks;
    let open = 0;
    let most = 0;
    const spare: number[] = [];
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const gate = async () => {
      open++;
      most = Math.max(most, open);
      spare.push(handle.spareSlots());
      await held;
      open--;
      return { lands: false, interrupted: true } as const;
    };
    const entry = async (n: number) => ({
      pull: { id: `slots-${concurrency}-${n}`, number: n, baseBranch: "main", headOid: await headAdding(`c${concurrency}-${n}`) } as Pull,
      dir,
      land: async () => undefined,
      release: () => {},
      handBack: () => {},
    });
    const options = { depth: 2, room: () => handle.spareSlots() };
    const repoId = `slots-${concurrency}`;
    const [first, second] = [await entry(1), await entry(2)];
    const one = enqueue(repoId, [first], gate, options);
    for (let i = 0; i < 2000 && open < 1; i++) await Bun.sleep(5);
    if (open < 1) throw new Error(`never came: still waiting while open < 1`);
    const two = enqueue(repoId, [second], gate, options);
    // Either it gates beside the first, or it still waits in line for it.
    for (let i = 0; i < 100 && open < 2; i++) await Bun.sleep(5);
    if (open < 2) expect(queueStatus().find((s) => s.repoId === repoId)?.queued).toBe(1);
    release();
    expect([...(await one), ...(await two)]).toEqual([false, false]);
    expect(extraGates()).toBe(0);
    return { most, spare };
  }

  test("a spare slot lets the next candidate gate beside the first, and it holds that slot", async () => {
    const { most, spare } = await gatesAtOnce(7);
    expect(most).toBe(2);
    // The second gate holds a slot: one fewer is spare while both run.
    // (The first is cut off, so the second is formed again on main after.)
    expect(spare.slice(0, 2)).toEqual([7 - PULL_RESERVE, 7 - PULL_RESERVE - 1]);
  });

  test("two slots are kept for pull checks: with two, the queue gates one candidate at a time", async () => {
    const { most, spare } = await gatesAtOnce(2);
    expect(most).toBe(1);
    expect(spare.every((n) => n === 0)).toBe(true);
  });
});
