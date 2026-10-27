/**
 * The merge queue says why a gate went red, and searches only a red that is
 * the code's (#5276). An install, setup or timeout red is gated once more,
 * then called infrastructure: no pull is handed back and nothing is
 * bisected. A pull that conflicts with an earlier one of its batch is left
 * out, named with it, and the rest land in that one gate.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStage, conflictWords, gateReason, reasonWords, searched } from "../src/checks/gate_reason.ts";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import { landVerdict, type LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";

describe("gateReason reads why a gate went red", () => {
  test("each stage and what the check printed", () => {
    expect(gateReason("install", "install exited with code 1", [], 0)).toEqual({ kind: "install" });
    expect(gateReason("setup", "the pull's base branch could not be found", [], 0)).toEqual({ kind: "setup" });
    expect(gateReason("timeout", "", [], 0)).toEqual({ kind: "timeout" });
    expect(gateReason("check", "check took longer than 7200s", [], 0)).toEqual({ kind: "timeout" });
    expect(gateReason("check", "2 of 9 tests", ["(fail) a", "(fail) b"], 2)).toEqual({ kind: "tests", failed: 2 });
    expect(gateReason("check", "x", ["src/a.ts(3,5): error TS2322: Type 'string' is not assignable"], 0)).toEqual({
      kind: "typecheck",
    });
    expect(gateReason("check", "check exited with code 1", ["lint: bad"], 0)).toEqual({ kind: "check" });
  });

  test("words for the log, and which reds are searched", () => {
    expect(reasonWords({ kind: "tests", failed: 3 })).toBe("tests: 3 failed");
    expect(reasonWords({ kind: "install" })).toBe("install");
    expect(reasonWords(undefined)).toBe("check");
    expect(conflictWords(5088, 5090)).toBe("merge-conflict (#5088 × #5090)");
    expect(conflictWords(undefined, 5090)).toBe("merge-conflict (main × #5090)");
    for (const kind of ["tests", "typecheck", "check"] as const)
      expect(searched(kind === "tests" ? { kind, failed: 1 } : { kind })).toBe(true);
    for (const kind of ["install", "setup", "timeout"] as const) expect(searched({ kind })).toBe(false);
    expect(searched(undefined)).toBe(true);
    expect(checkStage("check took longer than 60s")).toBe("timeout");
    expect(checkStage("check exited with code 1")).toBe("check");
  });

  test("the land verdict carries the reason", () => {
    expect(landVerdict(false, [], [], undefined, { kind: "install" })).toMatchObject({ reopen: true, reason: { kind: "install" } });
    expect(landVerdict(false, [], [])).not.toHaveProperty("reason");
  });
});

describe("the merge queue acts on why a gate went red", () => {
  let dir: string;
  const told: number[] = [];
  let logged: string[] = [];
  const spies: { mockRestore(): void }[] = [];

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-reason-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
    for (const level of ["info", "warn"] as const)
      spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(" "))));
  });

  afterEach(() => {
    logged = [];
    told.length = 0;
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function headWriting(branch: string, file: string, content = `${file}\n`): Promise<string> {
    git("checkout", "-q", "-B", branch, "main");
    git("reset", "-q", "--hard", "main");
    await Bun.write(join(dir, file), content);
    git("add", file);
    git("commit", "-q", "-m", file);
    git("checkout", "-q", "--detach");
    return git("rev-parse", branch);
  }

  function entry(prefix: string, number: number, headOid: string): Queued {
    return {
      pull: { id: `${prefix}-${number}`, number, baseBranch: "main", headOid } as Pull,
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

  const pullsOf = (c: Candidate) => c.steps.map((s) => s.entry.pull.number);
  const red = (reason: NonNullable<Extract<LandVerdict, { reopen: true }>["reason"]>): LandVerdict => ({
    lands: false,
    reopen: true,
    comment: "red",
    learn: [],
    reason,
  });

  test("an install red twice is infrastructure: gated twice, never bisected, no pull handed back", async () => {
    const pulls: Queued[] = [];
    for (let i = 1; i <= 4; i++) pulls.push(entry("install", i, await headWriting(`i${i}`, `i${i}.txt`)));
    const gates: number[][] = [];
    const gate = async (c: Candidate) => {
      gates.push(pullsOf(c));
      return red({ kind: "install" });
    };
    const answers = await enqueue("reason-install", pulls, gate, { depth: 1, room: () => 3 });
    expect(gates).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);
    expect(told).toEqual([]);
    expect(answers).toEqual([false, false, false, false]);
    expect(logged.some((l) => l.includes("gated 4 pulls: red (install)"))).toBe(true);
    expect(logged.some((l) => l.includes("gated 4 pulls: infrastructure (install, twice)"))).toBe(true);
  });

  test("an install red once, then green: the batch lands whole on the second gate", async () => {
    const pulls: Queued[] = [];
    for (let i = 11; i <= 13; i++) pulls.push(entry("flake", i, await headWriting(`j${i}`, `j${i}.txt`)));
    let n = 0;
    const gate = async (): Promise<LandVerdict> => (n++ === 0 ? red({ kind: "install" }) : { lands: true });
    const answers = await enqueue("reason-flake", pulls, gate, { depth: 1, room: () => 0 });
    expect(n).toBe(2);
    expect(answers).toEqual([true, true, true]);
    expect(told).toEqual([]);
  });

  test("a test red says how many failed and is still searched for its culprit", async () => {
    const pulls: Queued[] = [];
    for (let i = 21; i <= 22; i++) pulls.push(entry("tests", i, await headWriting(`k${i}`, i === 22 ? "bad.txt" : `k${i}.txt`)));
    const gate = async (c: Candidate): Promise<LandVerdict> =>
      git("ls-tree", "--name-only", c.tipOid).split("\n").includes("bad.txt") ? red({ kind: "tests", failed: 2 }) : { lands: true };
    const answers = await enqueue("reason-tests", pulls, gate, { depth: 1, room: () => 0 });
    expect(answers).toEqual([true, false]);
    expect(told).toEqual([22]);
    expect(logged.some((l) => l.includes("gated 2 pulls: red (tests: 2 failed)"))).toBe(true);
  });

  test("#b conflicting with #a is left out and named; everything else lands in one gate", async () => {
    const a = entry("clash", 31, await headWriting("c31", "same.txt", "one\n"));
    const x = entry("clash", 32, await headWriting("c32", "c32.txt"));
    const b = entry("clash", 33, await headWriting("c33", "same.txt", "two\n"));
    const y = entry("clash", 34, await headWriting("c34", "c34.txt"));
    const gates: number[][] = [];
    const gate = async (c: Candidate): Promise<LandVerdict> => {
      gates.push(pullsOf(c));
      return { lands: true };
    };
    const answers = await enqueue("reason-clash", [a, x, b, y], gate, { depth: 1, room: () => 3 });
    expect(gates).toEqual([[31, 32, 34]]);
    expect(answers).toEqual([true, true, false, true]);
    expect(told).toEqual([]);
    expect(logged.some((l) => l.includes("left out of the batch: merge-conflict (#31 × #33)"))).toBe(true);
    expect(logged.some((l) => l.includes(": red"))).toBe(false);
  });
});
