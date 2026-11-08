/**
 * The merge queue (#2036). Green, approved pulls of one repository are
 * built into ONE candidate and gated once; green lands every one of them
 * and main ends at exactly the tree that was gated. Red bisects, lands the
 * green part and hands the culprit back. The gate here is a stand-in that
 * counts its runs and goes red on any tree holding a `red-*` file.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { readLearned } from "../src/checks/learned.ts";
import { batchWords, enqueue, gateDeadlineForTest, MAX_CANDIDATE, gateRuns, queueStatus, queueWords, type Queued } from "../src/checks/queue.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { queueBatch, setCapacity, validCapacity } from "../src/core/capacity.ts";
import { latestDecision } from "../src/core/decisions.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { landIfGreen, REGATE_RED_MS, regateDue, sweepGreen } from "../src/crew/autonomy.ts";
import { listComments } from "../src/core/issues.ts";
import { readQueues } from "../src/flow/queue.ts";
import { repoDir } from "../src/git/repos.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { forgetFlow } from "../src/system/flow_cache.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

/**
 * Ten pulls are twenty git pushes before the gate runs, and a loaded check
 * machine runs them eight times slower: the clock must not decide the verdict.
 */
const SLOW = 300_000;

describe("the merge queue", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;
  /** A gate a test holds open until it lets go. */
  let held: Promise<void> | undefined;
  /** Every candidate the gate was asked about, with its verdict. */
  const gated: { repo: string; commit: string; ok: boolean }[] = [];
  /** How many gates from now are cut off, as by the forge stopping under them. */
  let cutOff = 0;
  /** How many gates from now go red whatever the tree, as a machine's red would. */
  let flaky = 0;
  /** The signal the last gate was handed: the queue aborts it at the deadline. */
  let lastSignal: AbortSignal | undefined;
  /** Called as a gate starts, before the deadline can fire on a loaded machine. */
  let atGate: (() => void) | undefined;

  const git = (repo: Repo, ...args: string[]) =>
    Bun.spawnSync(["git", ...args], {
      cwd: repoDir(app.reposRoot, repo.ownerName, repo.name),
    })
      .stdout.toString()
      .trim();

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-merge-queue-"));
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
      gate: async (repo: Repo, _pull: Pull, commitOid: string, signal?: AbortSignal) => {
        lastSignal = signal;
        atGate?.();
        if (held !== undefined) await held;
        if (cutOff > 0) {
          cutOff--;
          return { ok: false, error: "aborted", lines: ["(fail) killed [1.00ms]"], interrupted: true };
        }
        const files = git(repo, "ls-tree", "-r", "--name-only", commitOid).split("\n");
        const ok = flaky > 0 ? (flaky--, false) : !files.some((f) => f.startsWith("red-"));
        gated.push({ repo: repo.id, commit: commitOid, ok });
        return ok
          ? { ok, error: "", lines: [] }
          : { ok, error: "red", lines: ["test/red.test.ts:", "(fail) goes red [1.00ms]"] };
      },
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
        {
          path: "forge.json",
          content: JSON.stringify({ check: { run: "true", fast: "true", full: "true" } }),
        },
      ],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', autonomy_by = ?2 WHERE id = ?1")
      .run(made.value.id, alice.id);
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
    const opened = await openPull(app, alice, repo, {
      title: path,
      baseBranch: "main",
      headBranch: `feature/${path}`,
    });
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

  const login = async (): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  /** The MCP `flow` tool's `queue` field, as alice reads it. */
  const mcpQueue = async () => {
    forgetFlow(app); // the MCP flow tool answers a copy a few seconds old
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${createToken(app.db, alice.id, "t", "ro").token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flow", arguments: {} } }),
    });
    const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).not.toBe(true);
    return (JSON.parse(body.result.content[0]!.text) as { queue: unknown[] }).queue;
  };
  /** The terminal Flow dialog's line for one repository's queue. */
  const terminalLine = (repo: Repo) =>
    flowLines(app.db).find((l) => l.startsWith(`alice/${repo.name} `));
  const gatesOf = (repo: Repo) => gated.filter((g) => g.repo === repo.id);
  const tree = (repo: Repo, rev: string) => git(repo, "rev-parse", `${rev}^{tree}`);
  const merged = (repo: Repo, pull: Pull) => getPull(app.db, repo.id, pull.number)!.mergedAt !== null;

  test("four green pulls: one gate run, four landings, and main is the gated tree", async () => {
    const repo = await autonomousRepo("four-green");
    const pulls = [];
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts"]) pulls.push(await greenPull(repo, name));
    expect(await sweepGreen(app, repo)).toBe(4);
    expect(gatesOf(repo)).toHaveLength(1);
    expect(gateRuns(repo.id)).toBe(1);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(tree(repo, "refs/heads/main")).toBe(tree(repo, gatesOf(repo)[0]!.commit));
    // Four commits on main, in queue order, each the pull's own squash.
    const subjects = git(repo, "log", "--format=%s", "-4", "refs/heads/main").split("\n");
    expect(subjects).toEqual(["d.ts (#4)", "c.ts (#3)", "b.ts (#2)", "a.ts (#1)"]);
    expect(queueStatus().some((s) => s.repoId === repo.id)).toBe(false);
  });

  test("ten green pulls: a candidate carries eight, the next the other two, and the log says each gate (#3430)", async () => {
    const repo = await autonomousRepo("ten-green");
    const base = git(repo, "rev-parse", "refs/heads/main");
    const pulls = [];
    for (let i = 0; i < 10; i++) pulls.push(await greenPull(repo, `p${i}.ts`));
    const said: string[] = [];
    const info = console.info;
    // The log floor is process-wide: the verdict must not hang on what ran before.
    const floor = logLevel();
    setLogLevel("info");
    console.info = (line: string) => said.push(line);
    try {
      expect(await sweepGreen(app, repo)).toBe(10);
    } finally {
      console.info = info;
      setLogLevel(floor);
    }
    expect(MAX_CANDIDATE).toBe(8);
    expect(gatesOf(repo)).toHaveLength(2);
    // Which gate answers first is the machine's call: the verdict is the
    // shape, eight on main and the other two on top of them.
    const carried = gatesOf(repo)
      .map((g) => Number(git(repo, "rev-list", "--count", `${base}..${g.commit}`)))
      .sort((a, b) => a - b);
    expect(carried).toEqual([8, 10]);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    const queue = said.filter((l) => l.includes("[queue] "));
    expect(queue.some((l) => /\[queue\] gating 8 pulls since \d\d:\d\d .*waiting=\d/.test(l))).toBe(true);
    expect(queue.some((l) => l.includes("[queue] gated 8 pulls: green"))).toBe(true);
    expect(queue.some((l) => l.includes("[queue] gated 2 pulls: green"))).toBe(true);
  }, SLOW);

  test("queue.batch is read on each sweep: three per candidate when it says 3, and /settings/capacity explains the trade-off (#6674)", async () => {
    const repo = await autonomousRepo("batch-of-three");
    const base = git(repo, "rev-parse", "refs/heads/main");
    const pulls = [];
    for (let i = 0; i < 7; i++) pulls.push(await greenPull(repo, `b${i}.ts`));
    expect(validCapacity("queue.batch", "33")).toBe(false);
    expect(validCapacity("queue.batch", "0")).toBe(false);
    setCapacity(app.db, "queue.batch", "3", alice.id);
    try {
      expect(await sweepGreen(app, repo)).toBe(7);
    } finally {
      setCapacity(app.db, "queue.batch", null, alice.id);
    }
    const carried = gatesOf(repo)
      .map((g) => Number(git(repo, "rev-list", "--count", `${base}..${g.commit}`)))
      .sort((a, b) => a - b);
    expect(carried).toEqual([3, 6, 7]);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    expect(batchWords(repo.id, queueBatch(app.db))).toBe("8");
    const page = await fetch(`${servers.url}/settings/capacity`, { headers: { cookie: await login() } });
    const html = await page.text();
    expect(html).toContain("Merge queue batch size");
    expect(html).toContain("a red one costs more search gates");
  }, SLOW);

  test("after a red batch, the good pulls go back into ONE candidate up to the cap, not one gate each (#4053)", async () => {
    const repo = await autonomousRepo("rebatch");
    const pulls = [];
    for (let i = 0; i < 12; i++) pulls.push(await greenPull(repo, i === 1 ? "red-b.ts" : `q${i}.ts`));
    const said: string[] = [];
    const info = console.info;
    // The log floor is process-wide: the verdict must not hang on what ran before.
    const floor = logLevel();
    setLogLevel("info");
    console.info = (line: string) => said.push(line);
    try {
      expect(await sweepGreen(app, repo)).toBe(11);
    } finally {
      console.info = info;
      setLogLevel(floor);
    }
    const sizes = said.flatMap((l) => /\[queue\] gating (\d+) pulls? since/.exec(l)?.[1] ?? []).map(Number);
    // The first eight are red and halving finds the culprit; the rest go back
    // together. With a check slot free the search splits (#4999): the head of
    // a red batch is gated alone beside the line, so besides the culprit one
    // more lone gate is the search's own. How many gates overlap is the
    // machine's call, so the verdict is the shape: the cap holds, eleven good
    // pulls are not eleven gates, and once the first eight are red the four
    // fresh pulls behind them are one candidate, not four.
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_CANDIDATE);
    expect(sizes.filter((n) => n === 1).length).toBeLessThanOrEqual(2);
    expect(sizes.length).toBeLessThan(11);
    const after = sizes.slice(sizes.indexOf(MAX_CANDIDATE) + 1);
    expect(after.some((n) => n >= 4)).toBe(true);
    for (const [i, pull] of pulls.entries()) expect(merged(repo, pull)).toBe(i !== 1);
    expect(latestDecision(app.db, pulls[1]!.id, "land")?.answer).toBe("red");
  }, SLOW);

  test("the sweep reads every open pull: an approved one older than the newest fifty is queued with the rest (#4053)", async () => {
    const repo = await autonomousRepo("many-open");
    const old = await greenPull(repo, "old.ts");
    // Fifty newer pulls, none of them checked: the sweep passes them by.
    for (let i = 0; i < 50; i++) {
      const pushed = await commitToBranch(app, alice, repo, {
        branch: `feature/n${i}`,
        base: "main",
        message: `n${i}`,
        files: [{ path: `n${i}.ts`, content: `export const n = ${i};\n` }],
      });
      if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
      const opened = await openPull(app, alice, repo, { title: `n${i}`, baseBranch: "main", headBranch: `feature/n${i}` });
      if (!opened.ok) throw new Error(String(opened.error));
    }
    const fresh = await greenPull(repo, "fresh.ts");
    expect(await sweepGreen(app, repo)).toBe(2);
    expect(merged(repo, old)).toBe(true);
    expect(merged(repo, fresh)).toBe(true);
    // One candidate carried both.
    expect(gatesOf(repo)).toHaveLength(1);
  }, SLOW);

  test("one red among four: three land, the culprit is handed back, three gate runs", async () => {
    const repo = await autonomousRepo("one-red");
    const pulls = [];
    for (const name of ["a.ts", "b.ts", "c.ts", "red-d.ts"]) pulls.push(await greenPull(repo, name));
    const base = git(repo, "rev-parse", "refs/heads/main");
    expect(await sweepGreen(app, repo)).toBe(3);
    expect(gatesOf(repo).length).toBeLessThanOrEqual(3);
    const [a, b, c, red] = pulls as [Pull, Pull, Pull, Pull];
    for (const pull of [a, b, c]) expect(merged(repo, pull)).toBe(true);
    expect(merged(repo, red)).toBe(false);
    // Main is a tree the gate passed; nothing red reached it.
    const green = gatesOf(repo).filter((g) => g.ok).map((g) => tree(repo, g.commit));
    expect(green).toContain(tree(repo, "refs/heads/main"));
    expect(git(repo, "ls-tree", "--name-only", "refs/heads/main")).not.toContain("red-d.ts");
    // Handed back: the red is told once, on the pull, and taught.
    const told = latestDecision(app.db, red.id, "land");
    expect(told?.answer).toBe("red");
    expect((told?.state as { at?: string }).at?.startsWith(`${red.headOid}:`)).toBe(true);
    expect((told?.state as { at?: string }).at).not.toBe(`${red.headOid}:${base}`);
    expect(readLearned(dataDir, red.id)).toEqual(["test/red.test.ts"]);
    // Told red on this head and base: the next sweep does not gate it again.
    const before = gatesOf(repo).length;
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(gatesOf(repo)).toHaveLength(before);
  });

  test("a red first in line: the other three still land, and the culprit is handed back", async () => {
    const repo = await autonomousRepo("red-first");
    const pulls = [];
    for (const name of ["red-a.ts", "b.ts", "c.ts", "d.ts"]) pulls.push(await greenPull(repo, name));
    expect(await sweepGreen(app, repo)).toBe(3);
    // Whole red, front half red, the culprit alone red, the rest green.
    expect(gatesOf(repo).length).toBeLessThanOrEqual(4);
    const [red, ...rest] = pulls as [Pull, Pull, Pull, Pull];
    for (const pull of rest) expect(merged(repo, pull)).toBe(true);
    expect(merged(repo, red)).toBe(false);
    expect(latestDecision(app.db, red.id, "land")?.answer).toBe("red");
    expect(tree(repo, "refs/heads/main")).toBe(tree(repo, gatesOf(repo).at(-1)!.commit));
  });

  test("a pull that conflicts with one ahead of it is left out; the rest land as gated", async () => {
    const repo = await autonomousRepo("conflict");
    const first = await greenPull(repo, "same.ts");
    // Another branch writes the same path differently.
    const pushed = await commitToBranch(app, alice, repo, {
      branch: "feature/other",
      base: "main",
      message: "other",
      files: [{ path: "same.ts", content: "export const n = 2;\n" }],
    });
    if (!pushed.ok) throw new Error(JSON.stringify(pushed.error));
    const opened = await openPull(app, alice, repo, {
      title: "other",
      baseBranch: "main",
      headBranch: "feature/other",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    const other = getPull(app.db, repo.id, opened.value.number)!;
    const check = createRun(app.db, {
      repoId: repo.id,
      kind: "check",
      issueId: other.id,
      env: `pull-${other.number}`,
      commitOid: other.headOid,
      reason: "pull",
    });
    claimRun(app.db, check.id);
    finishRun(app.db, check.id, { state: "ok", summary: "check passed" });
    const last = await greenPull(repo, "last.ts");
    expect(await sweepGreen(app, repo)).toBe(2);
    expect(gatesOf(repo)).toHaveLength(1);
    expect(merged(repo, first)).toBe(true);
    expect(merged(repo, last)).toBe(true);
    expect(merged(repo, other)).toBe(false);
    expect(tree(repo, "refs/heads/main")).toBe(tree(repo, gatesOf(repo)[0]!.commit));
  });

  test("a release cut while a gate is green and in flight does not void it: the pulls land on the new tip, one gate (#6640)", async () => {
    const repo = await autonomousRepo("release-mid-gate");
    const pulls = [];
    for (const name of ["a.ts", "b.ts"]) pulls.push(await greenPull(repo, name));
    // The release record is pushed to main while the gate runs.
    held = (async () => {
      const cut = await commitToBranch(app, alice, repo, {
        message: "Release 0.0.1",
        files: [{ path: "src/core/releases.json", content: "[]\n" }],
      });
      if (!cut.ok) throw new Error(JSON.stringify(cut.error));
    })();
    const base = git(repo, "rev-parse", "refs/heads/main");
    try {
      expect(await sweepGreen(app, repo)).toBe(2);
    } finally {
      held = undefined;
    }
    expect(git(repo, "rev-parse", "refs/heads/main")).not.toBe(base);
    expect(gatesOf(repo)).toHaveLength(1);
    for (const pull of pulls) expect(merged(repo, pull)).toBe(true);
    const files = git(repo, "ls-tree", "--name-only", "refs/heads/main");
    expect(git(repo, "ls-tree", "-r", "--name-only", "refs/heads/main")).toContain("src/core/releases.json");
    expect(files).toContain("a.ts");
    expect(files).toContain("b.ts");
  });

  test("a base move that touches a file the candidate changes still voids the gate (#6640)", async () => {
    const repo = await autonomousRepo("overlap-mid-gate");
    const pull = await greenPull(repo, "a.ts");
    held = (async () => {
      const moved = await commitToBranch(app, alice, repo, {
        message: "Same file",
        files: [{ path: "a.ts", content: "export const n = 'other';\n" }],
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    })();
    const base = git(repo, "rev-parse", "refs/heads/main");
    try {
      await sweepGreen(app, repo);
    } finally {
      held = undefined;
    }
    expect(merged(repo, pull)).toBe(false);
    // Main moved by the competing commit alone, and nothing is left half-landed.
    expect(git(repo, "rev-list", "--count", `${base}..refs/heads/main`)).toBe("1");
    expect(git(repo, "log", "-1", "--format=%s", "refs/heads/main")).toBe("Same file");
    expect(gatesOf(repo).length).toBeLessThanOrEqual(1);
  });

  test("a disjoint move of live files that breaks the gate is no exemption: the pull does not land (#6640)", async () => {
    const repo = await autonomousRepo("breaking-mid-gate");
    const pull = await greenPull(repo, "a.ts");
    held = (async () => {
      const moved = await commitToBranch(app, alice, repo, {
        message: "Breaks the gate",
        files: [{ path: "red-other.ts", content: "export const x = 1;\n" }],
      });
      if (!moved.ok) throw new Error(JSON.stringify(moved.error));
    })();
    try {
      await sweepGreen(app, repo);
    } finally {
      held = undefined;
    }
    expect(merged(repo, pull)).toBe(false);
    expect(git(repo, "ls-tree", "-r", "--name-only", "refs/heads/main")).not.toContain("a.ts");
  });

  test("a docs-only move voids the gate: tests read docs, so the pull is gated again on the new base (#6640)", async () => {
    const repo = await autonomousRepo("docs-mid-gate");
    const pull = await greenPull(repo, "a.ts");
    // The doc lands while the gate runs, not before it starts: on a loaded
    // machine a move begun up front can beat the sweep, and the gate then
    // rightly runs on the new base and lands.
    atGate = () => {
      atGate = undefined;
      held = (async () => {
        const moved = await commitToBranch(app, alice, repo, {
          message: "A doc",
          files: [{ path: "docs/NOTE.md", content: "# note\n" }],
        });
        if (!moved.ok) throw new Error(JSON.stringify(moved.error));
      })();
    };
    try {
      await sweepGreen(app, repo);
    } finally {
      atGate = undefined;
      held = undefined;
    }
    // Voided: not landed on the gate that ran before the move.
    expect(merged(repo, pull)).toBe(false);
    expect(gatesOf(repo)).toHaveLength(1);
    await sweepGreen(app, repo);
    expect(gatesOf(repo)).toHaveLength(2);
    expect(merged(repo, pull)).toBe(true);
  });

  test("a gated step lands only on the base and as the tree it was gated with", async () => {
    const repo = await autonomousRepo("guarded");
    const pull = await greenPull(repo, "guard.ts");
    const tip = git(repo, "rev-parse", "refs/heads/main");
    const wrongBase = await mergePull(app, alice, repo, pull, "squash", {
      baseOid: git(repo, "rev-parse", "refs/heads/main~1"),
      treeOid: tree(repo, "refs/heads/main"),
    });
    expect(wrongBase.ok).toBe(false);
    if (!wrongBase.ok) expect(wrongBase.error).toEqual({ kind: "base_moved" });
    const wrongTree = await mergePull(app, alice, repo, pull, "squash", {
      baseOid: tip,
      treeOid: tree(repo, tip),
    });
    expect(wrongTree.ok).toBe(false);
    if (!wrongTree.ok) expect(wrongTree.error).toEqual({ kind: "base_moved" });
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(tip);
    expect(merged(repo, pull)).toBe(false);
  });

  test("a later step refused: the steps that landed are still released, once, at the last of them", async () => {
    const repo = await autonomousRepo("prefix");
    const pulls = [];
    for (const name of ["p.ts", "q.ts", "r.ts"]) pulls.push(await greenPull(repo, name));
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const released: { pull: number; tip: string }[] = [];
    // A stand-in landing: the first two land at a made-up tip, the third is
    // refused as if its head moved during the gate.
    const entries: Queued[] = pulls.map((pull, i) => ({
      pull,
      dir,
      land: async () => (i < 2 ? `tip-${pull.number}` : undefined),
      release: (tip) => released.push({ pull: pull.number, tip }),
      handBack: () => {},
    }));
    const answers = await enqueue(repo.id, entries, async () => ({ lands: true }));
    expect(answers).toEqual([true, true, false]);
    expect(released).toEqual([{ pull: pulls[1]!.number, tip: `tip-${pulls[1]!.number}` }]);
  });

  test("the queue shows through every door: /boards, the terminal and MCP, while gating and after", async () => {
    const repo = await autonomousRepo("on-flow");
    const first = await greenPull(repo, "first.ts");
    const second = await greenPull(repo, "second.ts");
    const third = await greenPull(repo, "third.ts");
    let release = (): void => {};
    held = new Promise<void>((r) => (release = r));
    // The first joins alone and is gated; the two after wait in line.
    const landing = landIfGreen(app, repo, first);
    while (!queueStatus().some((q) => q.repoId === repo.id && q.gating > 0)) await Bun.sleep(5);
    const waiting = Promise.all([landIfGreen(app, repo, second), landIfGreen(app, repo, third)]);
    while (!queueStatus().some((q) => q.repoId === repo.id && q.queued === 2)) await Bun.sleep(5);
    const row = readQueues(app.db, new Date()).find((r) => r.repo === `alice/${repo.name}`);
    expect(row).toMatchObject({ queued: 2, gating: 1 });
    const res = await fetch(`${servers.url}/boards`, {
      headers: { cookie: await login() },
      redirect: "manual",
    });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toMatch(
      /data-queue="alice\/on-flow">[\s\S]*?data-queued>2<[\s\S]*?data-gating>1<[\s\S]*?data-landed>0</,
    );
    // The terminal's Flow dialog and the MCP tool say the same.
    expect(terminalLine(repo)?.split(/\s+/)).toEqual([`alice/${repo.name}`, "2", "1", "1", "0", "—"]);
    expect(await mcpQueue()).toContainEqual({ repo: `alice/${repo.name}`, queued: 2, gating: 1, gates: 1, landedHour: 0, approvedToLanded: null });
    held = undefined;
    release();
    expect(await landing).toBe(true);
    // The two that waited are one candidate and one more gate.
    expect(await waiting).toEqual([true, true]);
    expect(gatesOf(repo)).toHaveLength(2);
    expect(readQueues(app.db, new Date()).find((r) => r.repo === `alice/${repo.name}`)).toMatchObject({
      queued: 0,
      gating: 0,
      landedHour: 3,
    });
    expect(terminalLine(repo)?.split(/\s+/)).toEqual([`alice/${repo.name}`, "0", "0", "0", "3", "—"]);
    expect(await mcpQueue()).toContainEqual({ repo: `alice/${repo.name}`, queued: 0, gating: 0, gates: 0, landedHour: 3, approvedToLanded: null });
  });

  /** Ages the pull's newest land decision past the re-gate wait. */
  const age = (pull: Pull) =>
    app.db
      .query(
        "UPDATE decision SET created_at = ?2 WHERE id = (SELECT id FROM decision WHERE issue_id = ?1 AND kind = 'land' ORDER BY created_at DESC, id DESC LIMIT 1)",
      )
      .run(pull.id, new Date(Date.now() - REGATE_RED_MS - 1000).toISOString());

  test("a gate cut off by the forge stopping is no red: the next sweep gates it again and it lands, no push (#3155)", async () => {
    const repo = await autonomousRepo("cut-off");
    const pull = await greenPull(repo, "a.ts");
    const base = git(repo, "rev-parse", "refs/heads/main");
    cutOff = 1;
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(cutOff).toBe(0);
    // Nothing told: no red on the ledger, no comment, nothing learned.
    expect(latestDecision(app.db, pull.id, "land")?.answer).not.toBe("red");
    expect(listComments(app.db, pull.id)).toHaveLength(0);
    expect(readLearned(dataDir, pull.id)).toEqual([]);
    // The forge that carries on, on the same head and base, lands it.
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(base);
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(merged(repo, pull)).toBe(true);
  });

  test("a gate that never answers is abandoned at the deadline, and the next sweep lands (#3430)", async () => {
    const repo = await autonomousRepo("never-answers");
    const pull = await greenPull(repo, "a.ts");
    expect(queueWords(repo.id)).toBe("idle");
    // The deadline is fired by hand once the gate is reached: a wall clock
    // would race the gate's setup on a loaded machine.
    const fires: (() => void)[] = [];
    const restore = gateDeadlineForTest(1500, (f) => {
      fires.push(f);
      return setTimeout(() => {}, 0);
    });
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => warned.push(line);
    held = new Promise<void>(() => {});
    let words = "";
    try {
      lastSignal = undefined;
      atGate = () => {
        words = queueWords(repo.id);
        for (const f of fires) f();
      };
      const sweep = sweepGreen(app, repo);
      expect(await sweep).toBe(0);
    } finally {
      held = undefined;
      atGate = undefined;
      console.warn = warn;
      restore();
    }
    expect(words).toMatch(/^gating 1 pull since \d\d:\d\d$/);
    expect((lastSignal as AbortSignal | undefined)?.aborted).toBe(true);
    expect(warned.some((l) => l.includes("[queue] candidate abandoned") && l.includes(`#${pull.number}`))).toBe(true);
    expect(queueWords(repo.id)).toBe("idle");
    // No verdict: nothing told, and the line forms again on the next sweep.
    expect(latestDecision(app.db, pull.id, "land")?.answer).not.toBe("red");
    expect(listComments(app.db, pull.id)).toHaveLength(0);
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(merged(repo, pull)).toBe(true);
  }, SLOW);

  test("a red cut off mid-bisection hands no one back; the line lands on the next sweep", async () => {
    const repo = await autonomousRepo("cut-off-bisect");
    const pulls = [];
    for (const name of ["a.ts", "b.ts", "red-c.ts", "d.ts"]) pulls.push(await greenPull(repo, name));
    const red = pulls[2]!;
    // The whole candidate is red; the gate of its front half is cut off.
    let calls = 0;
    const stopping = async () => {
      calls++;
      return calls === 1
        ? ({ lands: false, reopen: true, comment: "red", learn: [] } as const)
        : ({ lands: false, interrupted: true } as const);
    };
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const told: number[] = [];
    const answers = await enqueue(
      repo.id,
      pulls.map((pull) => ({
        pull,
        dir,
        land: async () => undefined,
        release: () => {},
        handBack: () => told.push(pull.number),
      })),
      stopping,
    );
    expect(calls).toBe(2);
    expect(answers).toEqual([false, false, false, false]);
    expect(told).toEqual([]);
    expect(await sweepGreen(app, repo)).toBe(3);
    expect(merged(repo, red)).toBe(false);
    expect(latestDecision(app.db, red.id, "land")?.answer).toBe("red");
  });

  test("a red neither side moved off is gated once more after 30 minutes, and lands if it was not the code's (#3155)", async () => {
    const repo = await autonomousRepo("regate-green");
    const pull = await greenPull(repo, "a.ts");
    flaky = 1;
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(latestDecision(app.db, pull.id, "land")?.answer).toBe("red");
    // Fresh: the red stands, and is not gated again.
    const before = gatesOf(repo).length;
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(gatesOf(repo)).toHaveLength(before);
    // Past the wait, with nothing moved: gated once more, green, landed.
    age(pull);
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(gatesOf(repo)).toHaveLength(before + 1);
    expect(merged(repo, pull)).toBe(true);
  });

  test("a red that reproduces on the re-gate stays red, told once", async () => {
    const repo = await autonomousRepo("regate-red");
    const pull = await greenPull(repo, "red-a.ts");
    expect(await sweepGreen(app, repo)).toBe(0);
    const comments = listComments(app.db, pull.id).length;
    expect(comments).toBe(1);
    age(pull);
    expect(await sweepGreen(app, repo)).toBe(0);
    const again = latestDecision(app.db, pull.id, "land");
    expect(again?.answer).toBe("red");
    expect((again?.state as { again?: boolean }).again).toBe(true);
    expect(regateDue(again!, Date.now() + 10 * REGATE_RED_MS)).toBe(false);
    expect(listComments(app.db, pull.id)).toHaveLength(comments);
    // However long it waits now, it is not gated again until a side moves.
    age(pull);
    const before = gatesOf(repo).length;
    expect(await sweepGreen(app, repo)).toBe(0);
    expect(gatesOf(repo)).toHaveLength(before);
  });

  test("a red pull stays out of the queue when main moves, and the re-gate gates it fresh with the pulls then waiting (#4235, #6493)", async () => {
    const repo = await autonomousRepo("red-stays-out");
    const a = await greenPull(repo, "a.ts");
    const red = await greenPull(repo, "red-x.ts");
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(merged(repo, a)).toBe(true);
    // Red on top of a, which landed first from the same candidate: it says so.
    expect(listComments(app.db, red.id).at(-1)?.body).toContain(`Red on top of #${a.number}`);
    // Main moves: a new base is no new try, so the red does not ride b's batch.
    const b = await greenPull(repo, "b.ts");
    let before = gatesOf(repo).length;
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(merged(repo, b)).toBe(true);
    expect(gatesOf(repo)).toHaveLength(before + 1);
    // Past the re-gate wait it joins again, behind the fresh pull and alone.
    age(red);
    const c = await greenPull(repo, "c.ts");
    before = gatesOf(repo).length;
    expect(await sweepGreen(app, repo)).toBe(1);
    expect(merged(repo, c)).toBe(true);
    // Main moved since it went red: it gates again as a fresh entry (#6493),
    // in the candidate with c, not behind c as a re-check.
    const [batch, ...rest] = gatesOf(repo).slice(before);
    expect(batch?.ok).toBe(false);
    expect(git(repo, "ls-tree", "--name-only", batch!.commit)).toContain("c.ts");
    expect(git(repo, "ls-tree", "--name-only", batch!.commit)).toContain("red-x.ts");
    expect(rest.at(-1)?.ok).toBe(true);
    // /boards: two red candidates of four in the hour.
    const page = await (await fetch(`${servers.url}/boards`, { headers: { cookie: await login() } })).text();
    expect(page).toMatch(/data-queue="alice\/red-stays-out">[\s\S]*?data-red-batches>2 of 4</);
    // The terminal's Flow dialog says the same, on a line of its own under the table.
    expect(flowLines(app.db).join(" ").replace(/\s+/g, " ")).toMatch(/Red batches, last hour: [^.]*alice\/red-stays-out 2 of 4/);
    // The MCP rows keep their shape: the rate is the page's and the terminal's.
    expect(Object.keys((await mcpQueue()).find((q) => (q as { repo: string }).repo === "alice/red-stays-out") as object)).not.toContain("batches");
  });
});
