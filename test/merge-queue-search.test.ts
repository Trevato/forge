/**
 * A red candidate is searched by prefixes of its own chain, each stacked on
 * the one before (#5994), so every green piece lands in order: a disjoint
 * segment gated on the base alone was void once another landed (#6353). The gate here is held open and
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

describe("the merge queue searches a red candidate by stacked prefixes", () => {
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

  /** A gate held open and let go a wave at a time: "at once" is counted, never timed. */
  function waves() {
    let pending: { candidate: Candidate; go: (v: LandVerdict) => void }[] = [];
    const seen: number[][][] = [];
    const greens: number[][] = [];
    const gate = (candidate: Candidate) => new Promise<LandVerdict>((go) => pending.push({ candidate, go }));
    const letGo = async (n: number) => {
      for (let i = 0; i < 2000 && pending.length < n; i++) await Bun.sleep(5);
      expect(pending).toHaveLength(n);
      const going = pending;
      pending = [];
      seen.push(going.map((p) => p.candidate.steps.map((s) => s.entry.pull.number)));
      for (const p of going) {
        const verdict = verdictOf(p.candidate);
        if (verdict.lands) greens.push(p.candidate.steps.map((s) => s.entry.pull.number));
        p.go(verdict);
      }
    };
    return { gate, letGo, seen, greens };
  }

  test("a red 7-step candidate with 3 free slots: the rest is searched by stacked prefixes, and every green prefix's pulls land", async () => {
    told.length = 0;
    const pulls: Queued[] = [];
    for (let i = 1; i <= 7; i++) pulls.push(entry(i, await headAdding(`s${i}`, i === 5 ? "bad.txt" : `f${i}.txt`)));
    const { gate, letGo, seen } = waves();
    const landed = enqueue("search", pulls, gate, { depth: 1, room: () => 3 });
    await letGo(1); // the whole candidate: red
    await letGo(2); // its head alone (#4999), beside the six without it
    await letGo(4); // the six: four prefixes of their own chain, each on the one before
    await letGo(1); // the pulls after the culprit, with the head, as one candidate
    const answers = await landed;
    expect(seen[2]).toEqual([[2, 3], [2, 3, 4], [2, 3, 4, 5], [2, 3, 4, 5, 6]]);
    expect(told).toEqual([5]);
    expect(answers[4]).toBe(false);
    expect(answers.filter(Boolean)).toHaveLength(6);
  });

  test("an 8-pull batch with one bad pull: the 7 good land, the search takes 2 gate rounds past the head's, and no green verdict is thrown away (#5994)", async () => {
    told.length = 0;
    const pulls: Queued[] = [];
    for (let i = 21; i <= 28; i++) pulls.push(entry(i, await headAdding(`u${i}`, i === 24 ? "bad.txt" : `f${i}.txt`)));
    const { gate, letGo, seen, greens } = waves();
    const landed = enqueue("search-eight", pulls, gate, { depth: 1, room: () => 7 });
    await letGo(1); // the eight: red
    await letGo(2); // its head alone (#4999), beside the seven without it: red
    await letGo(6); // round one: the seven, six prefixes at once; the culprit is named
    await letGo(1); // round two: the pulls after the culprit, with the head
    const answers = await landed;
    expect(seen).toHaveLength(4);
    expect(told).toEqual([24]);
    expect(answers).toEqual(pulls.map((q) => q.pull.number !== 24));
    // Every gate that came back green holds only pulls that landed.
    for (const g of greens) for (const n of g) expect(n).not.toBe(24);
    expect(git("ls-tree", "--name-only", "refs/heads/main").split("\n")).not.toContain("bad.txt");
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

  test("prefixes [a,b] red and [a,b,c] green: a, b and c land in one step with no solo gate, the red is reported as a flake, no suspect is gated alone", async () => {
    told.length = 0;
    const pulls: Queued[] = [];
    for (let i = 31; i <= 34; i++) pulls.push(entry(i, await headAdding(`v${i}`, `f${i}.txt`)));
    const gates: number[][] = [];
    const flaked: string[] = [];
    const red = (name: string): LandVerdict => ({ lands: false, reopen: true, comment: "red", learn: [], tests: { passed: 0, failed: 1, failing: [{ name, file: "test/x.test.ts", errors: [] }] } });
    const gate = async (candidate: Candidate): Promise<LandVerdict> => {
      const numbers = candidate.steps.map((s) => s.entry.pull.number);
      gates.push(numbers);
      if (numbers.length === 4 || numbers.length === 2) return red(numbers.length === 4 ? "whole" : "flaky one");
      return { lands: true };
    };
    let calls = 0;
    const room = () => (calls++ === 0 ? 0 : 1);
    const answers = await enqueue("search-flake", pulls, gate, {
      depth: 1,
      room,
      onFlake: (_repo, reds) => flaked.push(...reds.flatMap((r) => ("tests" in r ? (r.tests?.failing.map((t) => t.name) ?? []) : []))),
    });
    expect(gates).toEqual([[31, 32, 33, 34], [31, 32], [31, 32, 33]]);
    // The whole was red and 34 is all that is left of it: the culprit, with no gate of its own.
    expect(answers).toEqual([true, true, true, false]);
    expect(told).toEqual([34]);
    expect(flaked).toEqual(["flaky one"]);
  });
});
