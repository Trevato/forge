/**
 * The merge queue, driven through the real check lane (#7354): a batch whose
 * only red is a budget test re-runs that file once, serially, and lands
 * when it passes — the test recorded as a flake. Red again on the re-run,
 * or red on a functional test, the batch is red and searched as before:
 * a functional red is never re-run.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { budgetRetries } from "../src/checks/budget_retry.ts";
import { flakeList } from "../src/checks/flake.ts";
import { gateCandidate } from "../src/checks/landing.ts";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { getPull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { repoDir } from "../src/git/repos.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** What the gate's sharded run prints for one red test in `t/a.test.ts`, then exits 1. */
const gateLog = (error: string): string =>
  [
    "cat <<'EOF'",
    "── shard 1/2 (exit 1, 2.0s): t/a.test.ts",
    "t/a.test.ts:",
    error,
    "(fail) grp > page [81.00ms]",
    " 0 pass",
    " 1 fail",
    "Ran 1 test across 1 file. [90.00ms]",
    "── shard 2/2 (exit 0, 1.0s): t/b.test.ts",
    "t/b.test.ts:",
    "(pass) fine [1.00ms]",
    " 1 pass",
    " 0 fail",
    "1 of 2 shards failed:",
    "(fail) grp > page [81.00ms] [shard 1]",
    "EOF",
    "exit 1",
    "",
  ].join("\n");

const BUDGET = "error: over budget (expectBudget): 81.0 ms is not under 50.0 ms (budget 50 ms, baseline 2.0 ms)";
const FUNCTIONAL = "error: expect(received).toBe(expected)";

describe("the merge queue re-runs a batch's budget-only reds once", () => {
  let dataDir: string;
  let app: App;
  let checks: ChecksHandle;
  let alice: User;
  const cells = process.env["FORGE_CELLS"];

  beforeAll(async () => {
    process.env["FORGE_CELLS"] = "off";
    dataDir = await mkdtemp(join(tmpdir(), "forge-budget-retry-"));
    app = createApp({ dataDir, port: 0 });
    checks = startChecks(app, { forgeUrl: "http://127.0.0.1:1", concurrency: 2 });
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
  });

  afterAll(async () => {
    await checks.stop({ drain: false });
    app.close();
    if (cells === undefined) delete process.env["FORGE_CELLS"];
    else process.env["FORGE_CELLS"] = cells;
    await rm(dataDir, { recursive: true, force: true });
  });

  /**
   * A repository whose gate prints `error` above its one red test, whose
   * `t/a.test.ts` does `body` when re-run, and two pulls, queued as a batch.
   */
  async function queueWith(name: string, error: string, body: string) {
    const made = await createRepo(app, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repo: Repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [
        { path: "forge.json", content: JSON.stringify({ check: { run: "true", fast: "true", full: "sh gate.sh" } }) },
        { path: "gate.sh", content: gateLog(error) },
        { path: "t/a.test.ts", content: `import { describe, expect, test } from "bun:test";\ndescribe("grp", () => { test("page", () => { ${body} }); });\n` },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", dir, ...args]).stdout.toString().trim();
    const handedBack: number[] = [];
    const entries: Queued[] = [];
    for (const n of [1, 2]) {
      const branched = await commitToBranch(app, alice, repo, {
        branch: `f${n}`,
        message: `Add f${n}`,
        files: [{ path: `f${n}.txt`, content: `${n}\n` }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, alice, repo, { title: `F${n}`, baseBranch: "main", headBranch: `f${n}` });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = getPull(app.db, repo.id, opened.value.number)!;
      entries.push({
        pull,
        dir,
        land: async (want: Expect) => {
          if (git("rev-parse", "refs/heads/main") !== want.baseOid) return undefined;
          const tip = git("-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", want.treeOid, "-p", want.baseOid, "-m", `#${pull.number}`);
          git("update-ref", "refs/heads/main", tip);
          return tip;
        },
        release: () => {},
        handBack: () => handedBack.push(pull.number),
      });
    }
    const gates: number[][] = [];
    const gate = (c: Candidate, signal: AbortSignal) => {
      gates.push(c.steps.map((s) => s.entry.pull.number));
      return gateCandidate(app, repo, c.steps[0]!.entry.pull, c.dir, c.tipOid, signal);
    };
    const landed = await enqueue(repo.id, entries, gate, { depth: 1, room: () => 0 });
    return { repo, landed, gates, handedBack, numbers: entries.map((e) => e.pull.number) };
  }

  test("a batch red only on a budget test that passes on the re-run lands whole, and the test is a flake", async () => {
    const { repo, landed, gates, handedBack, numbers } = await queueWith("budget-green", BUDGET, "expect(1).toBe(1);");
    expect(landed).toEqual([true, true]);
    expect(gates).toEqual([numbers]);
    expect(handedBack).toEqual([]);
    expect(budgetRetries(repo.id)).toEqual({ passed: 1, failed: 0 });
    expect(flakeList(app.db, Date.now()).find((f) => f.repo === "alice/budget-green")).toMatchObject({
      test: "grp > page",
      file: "t/a.test.ts",
      count: 1,
    });
  }, 90_000);

  test("a budget test red on the re-run too keeps the batch red, and the search goes on", async () => {
    const { repo, landed, gates, handedBack, numbers } = await queueWith("budget-red", BUDGET, "expect(1).toBe(2);");
    expect(landed).toEqual([false, false]);
    expect(gates[0]).toEqual(numbers);
    expect(gates.length).toBeGreaterThan(1);
    expect(handedBack.length).toBeGreaterThan(0);
    // Each gate re-ran once and failed; none passed.
    expect(budgetRetries(repo.id)).toEqual({ passed: 0, failed: gates.length });
    expect(flakeList(app.db, Date.now()).some((f) => f.repo === "alice/budget-red")).toBe(false);
  }, 90_000);

  test("a functional red is searched at once, never re-run, though its file would pass", async () => {
    const { repo, landed, gates, handedBack, numbers } = await queueWith("functional", FUNCTIONAL, "expect(1).toBe(1);");
    expect(landed).toEqual([false, false]);
    // The batch, then its front half at once: bisected, not gated again whole.
    expect(gates.slice(0, 2)).toEqual([numbers, [numbers[0]!]]);
    expect(handedBack.length).toBeGreaterThan(0);
    expect(budgetRetries(repo.id)).toEqual({ passed: 0, failed: 0 });
    expect(flakeList(app.db, Date.now()).some((f) => f.repo === "alice/functional")).toBe(false);
  }, 90_000);
});
