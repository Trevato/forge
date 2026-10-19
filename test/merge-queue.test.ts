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
import { enqueue, gateRuns, queueStatus, type Queued } from "../src/checks/queue.ts";
import { provideChecksForTest, type ChecksHandle } from "../src/checks/service.ts";
import { latestDecision } from "../src/core/decisions.ts";
import { getPull, type Pull } from "../src/core/pulls.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { landIfGreen, sweepGreen } from "../src/crew/autonomy.ts";
import { readQueues } from "../src/flow/queue.ts";
import { repoDir } from "../src/git/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createToken } from "../src/core/tokens.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

describe("the merge queue", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let servers: Servers;
  /** A gate a test holds open until it lets go. */
  let held: Promise<void> | undefined;
  /** Every candidate the gate was asked about, with its verdict. */
  const gated: { repo: string; commit: string; ok: boolean }[] = [];

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
      gate: async (repo: Repo, _pull: Pull, commitOid: string) => {
        if (held !== undefined) await held;
        const files = git(repo, "ls-tree", "-r", "--name-only", commitOid).split("\n");
        const ok = !files.some((f) => f.startsWith("red-"));
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
    expect(terminalLine(repo)?.split(/\s+/)).toEqual([`alice/${repo.name}`, "2", "1", "0"]);
    expect(await mcpQueue()).toContainEqual({ repo: `alice/${repo.name}`, queued: 2, gating: 1, landedHour: 0 });
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
    expect(terminalLine(repo)?.split(/\s+/)).toEqual([`alice/${repo.name}`, "0", "0", "3"]);
    expect(await mcpQueue()).toContainEqual({ repo: `alice/${repo.name}`, queued: 0, gating: 0, landedHour: 3 });
  });
});
