/**
 * A red batch is never formed again around the same head (#4999). The head
 * of a red batch is gated alone beside the line while the rest gate without
 * it, so the good pulls land while the suspect is judged; a pull in two red
 * batches waits for a verdict of its own and never heads a third. The gate
 * here reads the candidate's tree: red when it holds `bad.txt`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import type { LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";

describe("the merge queue judges a suspect alone", () => {
  let dir: string;
  /** Every hand-back: the pull, and the pulls it was red on top of. */
  const told: { pull: number; together: number[] }[] = [];

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-suspect-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A pull's head: one file added on main as it is now. */
  async function headAdding(branch: string, file: string): Promise<string> {
    git("checkout", "-q", "-B", branch, "main");
    git("reset", "-q", "--hard", "main");
    await Bun.write(join(dir, file), `${file}\n`);
    git("add", file);
    git("commit", "-q", "-m", file);
    git("checkout", "-q", "--detach");
    return git("rev-parse", branch);
  }

  const verdictOf = (candidate: Candidate): LandVerdict =>
    git("ls-tree", "--name-only", candidate.tipOid).split("\n").includes("bad.txt")
      ? { lands: false, reopen: true, comment: "red", learn: [] }
      : { lands: true };

  /** A queued pull that lands the way the forge does: only on the base it was gated on. */
  function entry(line: string, number: number, headOid: string): Queued {
    return {
      pull: { id: `${line}-${number}`, number, baseBranch: "main", headOid } as Pull,
      dir,
      land: async (expect: Expect) => {
        if (git("rev-parse", "refs/heads/main") !== expect.baseOid) return undefined;
        const tip = git("commit-tree", expect.treeOid, "-p", expect.baseOid, "-m", `#${number}`);
        git("update-ref", "refs/heads/main", tip);
        return tip;
      },
      release: () => {},
      handBack: (_red, _base, together) => told.push({ pull: number, together: [...together] }),
    };
  }

  test("one bad pull at the head, thirty good behind: the thirty land in two gate-times, the bad one is handed back after its solo red", async () => {
    const bad = entry("thirty", 1, await headAdding("bad", "bad.txt"));
    const good: Queued[] = [];
    for (let i = 0; i < 30; i++) good.push(entry("thirty", 2 + i, await headAdding(`g${i}`, `g${i}.txt`)));
    // The gate is held open and let go a wave at a time: "at once" is counted, never timed.
    let pending: { candidate: Candidate; go: (v: LandVerdict) => void }[] = [];
    const waves: number[][][] = [];
    const gate = (candidate: Candidate) =>
      new Promise<LandVerdict>((go) => pending.push({ candidate, go }));
    const letGo = async (n: number) => {
      for (let i = 0; i < 2000 && pending.length < n; i++) await Bun.sleep(5);
      expect(pending).toHaveLength(n);
      const going = pending;
      pending = [];
      waves.push(going.map((p) => p.candidate.steps.map((s) => s.entry.pull.number)));
      for (const p of going) p.go(verdictOf(p.candidate));
    };
    const landed = enqueue("thirty", [bad, ...good], gate, { depth: 4, room: () => 8 });
    // Gate-time one: four candidates, the first red on its head.
    await letGo(4);
    // Gate-time two: the head alone, beside the thirty in four candidates without it.
    await letGo(5);
    expect(await landed).toEqual([false, ...good.map(() => true)]);
    expect(waves[1]!.filter((w) => w.includes(1))).toEqual([[1]]);
    expect(waves[1]!.flat().sort((a, b) => a - b)).toEqual([1, ...good.map((q) => q.pull.number)]);
    expect(told).toEqual([{ pull: 1, together: [] }]);
    const files = git("ls-tree", "--name-only", "refs/heads/main").split("\n");
    expect(files).toHaveLength(30);
    expect(files).not.toContain("bad.txt");
  });

  test("a pull in two red batches never heads a third: it is gated alone, and handed back on its own red", async () => {
    told.length = 0;
    const bad = entry("twice", 1, await headAdding("bad2", "bad.txt"));
    const [g1, g2] = [entry("twice", 2, await headAdding("h1", "h1.txt")), entry("twice", 3, await headAdding("h2", "h2.txt"))];
    const gates: number[][] = [];
    // The search is cut off twice (the forge stopping): the batch is red, and nothing is decided.
    let cut = true;
    const gate = async (candidate: Candidate): Promise<LandVerdict> => {
      gates.push(candidate.steps.map((s) => s.entry.pull.number));
      if (cut && candidate.steps.length < 3) return { lands: false, interrupted: true };
      return verdictOf(candidate);
    };
    expect(await enqueue("twice", [bad, g1, g2], gate)).toEqual([false, false, false]);
    expect(await enqueue("twice", [bad, g1, g2], gate)).toEqual([false, false, false]);
    expect(gates.filter((g) => g.length === 3)).toHaveLength(2);
    cut = false;
    const before = gates.length;
    expect(await enqueue("twice", [bad, g1, g2], gate)).toEqual([false, true, true]);
    const after = gates.slice(before);
    // Each was in two red batches: each is judged alone, and the bad one heads no batch.
    expect(after.slice(0, 3)).toEqual([[1], [2], [3]]);
    expect(after.every((g) => g[0] !== 1 || g.length === 1)).toBe(true);
    expect(told).toEqual([{ pull: 1, together: [] }]);
    expect(git("ls-tree", "--name-only", "refs/heads/main").split("\n")).not.toContain("bad.txt");
  });
});
