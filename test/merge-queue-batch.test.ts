/**
 * The batch size (#6674): `queue.batch` caps how many pulls a candidate
 * carries; a red batch halves the line's size and two greens in a row
 * double it back; and a red batch of 16 with one bad pull lands its 15 good
 * in two rounds — √16 − 1 prefixes, then one gate per pull of the red run,
 * each leaving that pull out. The gate is held open and let go a wave at a
 * time, so "at once" is counted, never timed; it reads the candidate's tree:
 * red when it holds `bad.txt`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchWords, type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import type { LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";

describe("the merge queue's batch size", () => {
  let dir: string;
  const told: number[] = [];
  let landings = 0;

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-batch-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

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

  function entry(line: string, number: number, headOid: string): Queued {
    return {
      pull: { id: `${line}-${number}`, number, baseBranch: "main", headOid } as Pull,
      dir,
      land: async (expect: Expect) => {
        if (git("rev-parse", "refs/heads/main") !== expect.baseOid) return undefined;
        const tip = git("commit-tree", expect.treeOid, "-p", expect.baseOid, "-m", `#${number}`);
        git("update-ref", "refs/heads/main", tip);
        landings++;
        return tip;
      },
      release: () => {},
      handBack: () => told.push(number),
    };
  }

  async function pulls(line: string, from: number, count: number, bad?: number): Promise<Queued[]> {
    const out: Queued[] = [];
    for (let n = from; n < from + count; n++)
      out.push(entry(line, n, await headAdding(`${line}${n}`, n === bad ? "bad.txt" : `${line}${n}.txt`)));
    return out;
  }

  /** A gate that answers at once and keeps how many pulls each candidate carried. */
  function counting() {
    const sizes: number[] = [];
    const gate = async (candidate: Candidate) => {
      sizes.push(candidate.steps.length);
      return verdictOf(candidate);
    };
    return { gate, sizes };
  }

  test("the setting is honoured: 4 a candidate when told 4, 16 when told 16, never past 32", async () => {
    const four = counting();
    expect(await enqueue("told-four", await pulls("f", 1, 10), four.gate, { depth: 1, batch: 4 })).toEqual(
      Array(10).fill(true),
    );
    expect(four.sizes).toEqual([4, 4, 2]);
    const sixteen = counting();
    await enqueue("told-sixteen", await pulls("s", 1, 20), sixteen.gate, { depth: 1, batch: 16 });
    expect(sixteen.sizes).toEqual([16, 4]);
    expect(batchWords("told-sixteen", 16)).toBe("16");
    expect(batchWords("told-sixteen", 99)).toBe("32");
  });

  test("a red halves the batch, and two greens in a row double it back to the setting", async () => {
    told.length = 0;
    const { gate, sizes } = counting();
    // Eight, the first bad: red. The search finds it; the seven land.
    const first = await enqueue("adapts", await pulls("a", 1, 8, 1), gate, { depth: 1, batch: 8 });
    expect(first).toEqual([false, ...Array(7).fill(true)]);
    expect(told).toEqual([1]);
    expect(batchWords("adapts", 8)).toBe("4 of 8");
    // Sixteen good: two of four, both green, so the third is eight again.
    sizes.length = 0;
    expect(await enqueue("adapts", await pulls("a", 101, 16), gate, { depth: 1, batch: 8 })).toEqual(
      Array(16).fill(true),
    );
    expect(sizes).toEqual([4, 4, 8]);
    expect(batchWords("adapts", 8)).toBe("8");
  });

  test("a red 16-batch with one bad pull lands its 15 good within 2 rounds, then the bad one is handed back alone", async () => {
    told.length = 0;
    landings = 0;
    let pending: { candidate: Candidate; go: (v: LandVerdict) => void }[] = [];
    const seen: number[][][] = [];
    const gate = (candidate: Candidate) => new Promise<LandVerdict>((go) => pending.push({ candidate, go }));
    const letGo = async (n: number) => {
      for (let i = 0; i < 2000 && pending.length < n; i++) await Bun.sleep(5);
      expect(pending).toHaveLength(n);
      const going = pending;
      pending = [];
      seen.push(going.map((p) => p.candidate.steps.map((s) => s.entry.pull.number)));
      for (const p of going) p.go(verdictOf(p.candidate));
    };
    const line = await pulls("r", 1, 16, 6);
    // No free slot: the search still gates √16 − 1 = 3 prefixes.
    const landed = enqueue("red-sixteen", line, gate, { depth: 1, room: () => 0, batch: 16 });
    await letGo(1); // the sixteen: red
    await letGo(3); // round one: 4, 8 and 12 deep; the first four land, the red run is 5–8
    expect(seen[1]!.map((c) => c.length)).toEqual([4, 8, 12]);
    for (let i = 0; i < 2000 && pending.length < 4; i++) await Bun.sleep(5);
    expect(landings).toBe(4);
    await letGo(4); // round two: everything left but one of 5–8 each; the one without 6 lands
    expect(seen[2]!.map((c) => c.length)).toEqual([11, 11, 11, 11]);
    for (let i = 0; i < 2000 && landings < 15; i++) await Bun.sleep(5);
    expect(landings).toBe(15);
    expect(git("ls-tree", "--name-only", "refs/heads/main").split("\n").filter((f) => /^r\d+\.txt$/.test(f))).toHaveLength(15);
    await letGo(1); // the one left out, alone: red, handed back
    expect(seen[3]).toEqual([[6]]);
    expect(await landed).toEqual(line.map((q) => q.pull.number !== 6));
    expect(told).toEqual([6]);
    expect(git("ls-tree", "--name-only", "refs/heads/main").split("\n")).not.toContain("bad.txt");
    expect(batchWords("red-sixteen", 16)).toBe("8 of 16");
  });
});
