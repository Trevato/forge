/**
 * The merge queue names the tests that failed each gate (#6739), not just
 * how many: the gate's output is read for its counts and its failing tests
 * with their first error lines (`checks/gate_tests.ts`), the queue's log
 * line names them, every finished gate is kept a week in `gate_result`,
 * and `GET …/queue/gates` and the `queue_gates` MCP tool answer them. A test
 * red in two gates that share no pull is flagged flaky.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { failuresOf } from "../src/checks/failures.ts";
import { redWords } from "../src/checks/gate_reason.ts";
import { flakyTests, keepGateResult, recentGates, testKey } from "../src/checks/gate_result.ts";
import { gateTests } from "../src/checks/gate_tests.ts";
import { stopQueue } from "../src/checks/queue.ts";
import { provideChecksForTest, type ChecksHandle, type GateDone } from "../src/checks/service.ts";
import { createToken } from "../src/core/tokens.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { sweepGreen } from "../src/crew/autonomy.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mcpTool } from "./helpers/mcp.ts";

/** A sharded gate's output: two shards, a test red in each, and the tally repeating both. */
const RED_OUTPUT = [
  "── shard 1/2 (exit 1, 3.0s): test/a.test.ts",
  "bun test v1.3.14",
  "",
  "test/a.test.ts:",
  "(pass) a > fine [0.10ms]",
  '2 | test("a > b", () => { expect(1).toBe(2); });',
  "                                    ^",
  "error: expect(received).toBe(expected)",
  "",
  "Expected: 2",
  "Received: 1",
  "",
  "      at <anonymous> (/w/test/a.test.ts:2:33)",
  "(fail) a > b [0.15ms]",
  "",
  " 1 pass",
  " 1 fail",
  "── shard 2/2 (exit 1, 2.0s): test/c.test.ts",
  "test/c.test.ts:",
  "(pass) c > one [0.10ms]",
  "(pass) c > two [0.10ms]",
  "error: boom",
  "second line",
  "      at <anonymous> (/w/test/c.test.ts:3:49)",
  "(fail) c > d [0.05ms]",
  " 2 pass",
  " 1 fail",
  "",
  "2 of 2 shards failed:",
  "(fail) a > b [0.15ms] [shard 1]",
  "(fail) c > d [0.05ms] [shard 2]",
  "Ran 5 tests across 2 files in 5.0s; 2 failed.",
];

describe("a gate's tests, read from its output", () => {
  test("two failing tests: both named once, with their files, errors and the counts", () => {
    const read = gateTests(RED_OUTPUT);
    expect(read.passed).toBe(3);
    expect(read.failed).toBe(2);
    expect(read.failing).toEqual([
      {
        name: "a > b",
        file: "test/a.test.ts",
        errors: ["error: expect(received).toBe(expected)", "Expected: 2", "Received: 1", "at <anonymous> (/w/test/a.test.ts:2:33)"],
      },
      { name: "c > d", file: "test/c.test.ts", errors: ["error: boom", "second line", "at <anonymous> (/w/test/c.test.ts:3:49)"] },
    ]);
  });

  test("the shards' tally does not count a failing test twice", () => {
    expect(failuresOf(RED_OUTPUT).tests).toEqual(["a > b", "c > d"]);
  });

  test("at most 20 failing tests are named; the count stays whole", () => {
    const lines = ["test/x.test.ts:"];
    for (let i = 0; i < 25; i++) lines.push(`error: e${i}`, `(fail) t${i} [1.00ms]`);
    const read = gateTests(lines);
    expect(read.failed).toBe(25);
    expect(read.failing).toHaveLength(20);
    expect(read.failing[0]).toEqual({ name: "t0", file: "test/x.test.ts", errors: ["error: e0"] });
  });

  test("the log's words name the failing tests, the rest counted", () => {
    const read = gateTests(RED_OUTPUT);
    expect(redWords({ kind: "tests", failed: 2 }, read)).toBe('2 failed: "a > b", "c > d"');
    const many = { passed: 0, failed: 7, failing: Array.from({ length: 7 }, (_, i) => ({ name: `t${i}`, errors: [] })) };
    expect(redWords({ kind: "tests", failed: 7 }, many)).toBe('7 failed: "t0", "t1", "t2", "t3", "t4" and 2 more');
    // No test named: the reason, as before.
    expect(redWords({ kind: "typecheck" }, { passed: 0, failed: 0, failing: [] })).toBe("typecheck");
    expect(redWords({ kind: "tests", failed: 2 }, undefined)).toBe("tests: 2 failed");
  });

  test("a test red in two gates that share no pull is flaky; one shared pull explains it", () => {
    const x = { name: "x", file: "test/x.test.ts", errors: [] };
    const y = { name: "y", errors: [] };
    const flaky = flakyTests([
      { pulls: [1, 2], failing: [x, y] },
      { pulls: [3], failing: [x] },
      { pulls: [2, 5], failing: [y] },
    ]);
    expect(flaky.has(testKey(x))).toBe(true);
    expect(flaky.has(testKey(y))).toBe(false);
  });
});

describe("the merge queue keeps and names each gate's failing tests", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let token: string;
  let logged: string[] = [];
  const spies: { mockRestore(): void }[] = [];

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: repoDir(app.reposRoot, repo.ownerName, repo.name) })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-gate-result-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
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
    token = createToken(app.db, alice.id, "t", "ro").token;
    // The lane: red with two failing tests whenever the tip carries bad.ts.
    provideChecksForTest(app, {
      gate: async (repo: Repo, _pull: Pull, commitOid: string): Promise<GateDone> => {
        const files = git(repo, "ls-tree", "--name-only", commitOid).split("\n");
        return files.includes("bad.ts")
          ? { ok: false, error: "check exited with code 1", lines: RED_OUTPUT, stage: "check" }
          : { ok: true, error: "", lines: [] };
      },
      spareSlots: () => 0,
    } as unknown as ChecksHandle);
    for (const level of ["info", "warn"] as const)
      spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(" "))));
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    stopQueue();
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

  test("a red gate's two failing tests are kept, logged by name, and answered by the API and the MCP", async () => {
    const repo = await autonomousRepo("gate-result");
    const good = await greenPull(repo, "good.ts");
    const bad = await greenPull(repo, "bad.ts");
    expect(await sweepGreen(app, repo)).toBe(1);

    // The log line names them.
    expect(logged.some((l) => l.includes('gated 2 pulls: red (2 failed: "a > b", "c > d")'))).toBe(true);

    // The API: newest first, the red batch with both names and its counts.
    const res = await fetch(`${servers.url}/api/v1/repos/alice/gate-result/queue/gates?limit=20`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: any[]; next_cursor: unknown };
    expect(body.next_cursor).toBeNull();
    const red = body.items.find((g) => g.state === "red" && g.pulls.length === 2);
    expect(red).toBeDefined();
    expect(red.pulls).toEqual([good.number, bad.number]);
    expect(red.reason).toBe("tests");
    expect(red.passed).toBe(3);
    expect(red.failed).toBe(2);
    expect(red.failing.map((t: { name: string }) => t.name)).toEqual(["a > b", "c > d"]);
    expect(red.failed).toBe(red.failing.length);
    expect(red.failing[0].errors[0]).toBe("error: expect(received).toBe(expected)");
    expect(red.failing[0].flaky).toBe(false);
    expect(red.runId).toMatch(/^gate-[0-9a-f]{12}$/);
    expect(red.durationMs).toBeGreaterThanOrEqual(0);
    // The search's own gates are kept too: good.ts alone went green.
    expect(body.items.some((g) => g.state === "green" && g.pulls[0] === good.number)).toBe(true);
    // Newest first.
    const ids = body.items.map((g) => g.id as string);
    expect([...ids].sort().reverse()).toEqual(ids);

    // A page of one has a cursor, and the cursor reads on.
    const one = (await (
      await fetch(`${servers.url}/api/v1/repos/alice/gate-result/queue/gates?limit=1`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { items: { id: string }[]; next_cursor: string };
    expect(one.items).toHaveLength(1);
    const next = (await (
      await fetch(`${servers.url}/api/v1/repos/alice/gate-result/queue/gates?limit=1&cursor=${one.next_cursor}`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { items: { id: string }[] };
    expect(next.items[0]!.id < one.items[0]!.id).toBe(true);

    // The MCP tool answers the same.
    const mcp = await mcpTool(servers.url, token, "queue_gates", { repo: "alice/gate-result" });
    expect(mcp.error).toBeUndefined();
    const viaMcp = (mcp.value.gates as any[]).find((g) => g.state === "red" && g.pulls.length === 2);
    expect(viaMcp.failing.map((t: { name: string }) => t.name)).toEqual(["a > b", "c > d"]);
  });

  test("a private repository's gates are not found without access; a bad cursor is refused", async () => {
    const anon = await fetch(`${servers.url}/api/v1/repos/alice/gate-result/queue/gates`);
    expect(anon.status).toBe(404);
    const badCursor = await fetch(`${servers.url}/api/v1/repos/alice/gate-result/queue/gates?cursor=../x`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(badCursor.status).toBe(422);
  });

  test("the API flags a test red in two gates that share no pull, and prunes past a week", () => {
    const repo = getRepoById(app.db, app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'gate-result'").get()!.id)!;
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    const base = { repoId: repo.id, runId: "gate-000000000000", tipOid: "0".repeat(40), state: "red" as const, reason: "tests", passed: 1 };
    const flake = { name: "sometimes", file: "test/s.test.ts", errors: ["error: timed out"] };
    keepGateResult(app.db, "zz00000000000000000000001", { ...base, pulls: [901], failed: 1, failing: [flake], startedAt: at(2000), finishedAt: at(1000) }, now);
    keepGateResult(app.db, "zz00000000000000000000002", { ...base, pulls: [902], failed: 1, failing: [flake], startedAt: at(2000), finishedAt: at(1000) }, now);
    const gates = recentGates(app.db, repo.id, 2);
    expect(gates.map((g) => g.id)).toEqual(["zz00000000000000000000002", "zz00000000000000000000001"]);
    expect(gates[0]!.failing[0]).toMatchObject({ name: "sometimes", flaky: true });
    expect(gates[0]!.durationMs).toBe(1000);
    // A week and a day later, a new gate's write prunes them.
    const later = new Date(now.getTime() + 8 * 24 * 3_600_000);
    keepGateResult(app.db, "zz00000000000000000000003", { ...base, pulls: [903], failed: 0, failing: [], startedAt: later.toISOString(), finishedAt: later.toISOString() }, later);
    expect(recentGates(app.db, repo.id, 100).map((g) => g.id)).toEqual(["zz00000000000000000000003"]);
  });
});
