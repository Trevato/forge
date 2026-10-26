/**
 * A red candidate is searched by disjoint segments, never by nested
 * prefixes holding the same suspects (#6353). The gate here is held open and
 * let go a wave at a time, so "at once" is counted, never timed; it reads
 * the candidate's tree: red when it holds `bad.txt`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import type { LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";

describe("the merge queue searches a red candidate by disjoint segments", () => {
  let dir: string;
  const told: number[] = [];

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-search-"));
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

  function entry(number: number, headOid: string): Queued {
    return {
      pull: { id: `search-${number}`, number, baseBranch: "main", headOid } as Pull,
      dir,
      land: async (expect: Expect) => {
        if (git("rev-parse", "refs/heads/main") !== expect.baseOid) return undefined;
        const tip = git("commit-tree", expect.treeOid, "-p", expect.baseOid, "-m", `#${number}`);
        git("update-ref", "refs/heads/main", tip);
        return tip;
      },
      release: () => {},
      handBack: () => told.push(number),
    };
  }

  test("a red 7-step candidate with 3 free slots: the gates share no step, and a culprit at step 5 is found in 2 rounds beyond the head's", async () => {
    const pulls: Queued[] = [];
    for (let i = 1; i <= 7; i++) pulls.push(entry(i, await headAdding(`s${i}`, i === 5 ? "bad.txt" : `f${i}.txt`)));
    let pending: { candidate: Candidate; go: (v: LandVerdict) => void }[] = [];
    const waves: number[][][] = [];
    const gate = (candidate: Candidate) => new Promise<LandVerdict>((go) => pending.push({ candidate, go }));
    const letGo = async (n: number) => {
      for (let i = 0; i < 2000 && pending.length < n; i++) await Bun.sleep(5);
      expect(pending).toHaveLength(n);
      const going = pending;
      pending = [];
      waves.push(going.map((p) => p.candidate.steps.map((s) => s.entry.pull.number)));
      for (const p of going) p.go(verdictOf(p.candidate));
    };
    const landed = enqueue("search", pulls, gate, { depth: 1, room: () => 3 });
    await letGo(1); // the whole candidate: red
    await letGo(2); // its head alone (#4999), beside the six without it
    await letGo(4); // the six, cut into four segments gated at once
    await letGo(1); // the first segment landed as gated; the red one is gated on it
    await letGo(2); // the red segment, halved: the culprit is in it alone
    await letGo(1); // the pulls cleared alone, formed again as one candidate
    const answers = await landed;
    for (const wave of waves) {
      const seen = wave.flat();
      expect(new Set(seen).size).toBe(seen.length);
    }
    expect(waves[3]).toEqual([[5, 6]]);
    expect(waves[4]!.flat().sort()).toEqual([5, 6]);
    expect(told).toEqual([5]);
    expect(answers[4]).toBe(false);
    expect(answers.filter(Boolean)).toHaveLength(6);
  });

  test("with no slot free, the green front half lands and the red back half is not gated again", async () => {
    told.length = 0;
    const pulls: Queued[] = [];
    for (let i = 11; i <= 14; i++) pulls.push(entry(i, await headAdding(`t${i}`, i === 14 ? "bad.txt" : `f${i}.txt`)));
    const gates: number[][] = [];
    const gate = async (candidate: Candidate) => {
      gates.push(candidate.steps.map((s) => s.entry.pull.number));
      return verdictOf(candidate);
    };
    const answers = await enqueue("search-solo", pulls, gate, { depth: 1, room: () => 0 });
    // The whole, then the front half; the back half has the whole's tree on it: known red.
    expect(gates).toEqual([[11, 12, 13, 14], [11, 12], [13]]);
    expect(told).toEqual([14]);
    expect(answers).toEqual([true, true, true, false]);
  });
});
