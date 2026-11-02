/**
 * A `red (check)` — the check exited red and named no test and no type
 * error — is gated once more before the queue searches it (#6722): a check
 * cut short that printed no reason is not yet a red. Green the second time,
 * the batch lands whole with nothing bisected; red again, it is searched,
 * and the search's own prefixes are not gated twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import type { LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";
import { type LogLevel, logLevel, setLogLevel } from "../src/kernel/log.ts";

describe("the merge queue gates a red (check) once more before it searches", () => {
  let dir: string;
  const told: number[] = [];
  let logged: string[] = [];
  const spies: { mockRestore(): void }[] = [];
  let floor: LogLevel;

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-check-retry-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
    // The log floor is process-wide: a file before this one that raised it
    // and never lowered it (`bench/map-home.ts`'s `seedFixture`, #7419) hid
    // the line read below. This file sets its own and gives it back.
    floor = logLevel();
    setLogLevel("info");
    for (const level of ["info", "warn"] as const)
      spies.push(spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.join(" "))));
  });

  afterEach(() => {
    logged = [];
    told.length = 0;
  });

  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    setLogLevel(floor);
    await rm(dir, { recursive: true, force: true });
  });

  async function headWriting(branch: string, file: string): Promise<string> {
    git("checkout", "-q", "-B", branch, "main");
    git("reset", "-q", "--hard", "main");
    await Bun.write(join(dir, file), `${file}\n`);
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
  const redCheck: LandVerdict = { lands: false, reopen: true, comment: "red", learn: [], reason: { kind: "check" } };

  test("red (check) once, then green: the batch lands whole on the second gate, nothing bisected", async () => {
    const pulls: Queued[] = [];
    for (let i = 1; i <= 4; i++) pulls.push(entry("once", i, await headWriting(`a${i}`, `a${i}.txt`)));
    const gates: number[][] = [];
    const gate = async (c: Candidate): Promise<LandVerdict> => {
      gates.push(pullsOf(c));
      return gates.length === 1 ? redCheck : { lands: true };
    };
    const answers = await enqueue("check-retry-once", pulls, gate, { depth: 1, room: () => 3 });
    expect(gates).toEqual([[1, 2, 3, 4], [1, 2, 3, 4]]);
    expect(answers).toEqual([true, true, true, true]);
    expect(told).toEqual([]);
    expect(logged.some((l) => l.includes("red (check) named no test, gating once more"))).toBe(true);
    expect(logged.some((l) => l.includes("gated alone"))).toBe(false);
  });

  test("red (check) twice is the code's: searched, each prefix gated once, the culprit handed back", async () => {
    const pulls: Queued[] = [];
    for (let i = 11; i <= 12; i++) pulls.push(entry("twice", i, await headWriting(`b${i}`, i === 12 ? "bad.txt" : `b${i}.txt`)));
    const gates: number[][] = [];
    const gate = async (c: Candidate): Promise<LandVerdict> => {
      gates.push(pullsOf(c));
      return git("ls-tree", "--name-only", c.tipOid).split("\n").includes("bad.txt") ? redCheck : { lands: true };
    };
    const answers = await enqueue("check-retry-twice", pulls, gate, { depth: 1, room: () => 0 });
    // The batch twice, then the search's front half once: green, it lands, and #12 is the culprit.
    expect(gates).toEqual([[11, 12], [11, 12], [11]]);
    expect(answers).toEqual([true, false]);
    expect(told).toEqual([12]);
  });

  test("a test red is searched at once, as before", async () => {
    const pulls: Queued[] = [];
    for (let i = 21; i <= 22; i++) pulls.push(entry("tests", i, await headWriting(`c${i}`, i === 22 ? "bad.txt" : `c${i}.txt`)));
    const gates: number[][] = [];
    const gate = async (c: Candidate): Promise<LandVerdict> => {
      gates.push(pullsOf(c));
      return git("ls-tree", "--name-only", c.tipOid).split("\n").includes("bad.txt")
        ? { ...redCheck, reason: { kind: "tests", failed: 1 } }
        : { lands: true };
    };
    const answers = await enqueue("check-retry-tests", pulls, gate, { depth: 1, room: () => 0 });
    expect(gates).toEqual([[21, 22], [21]]);
    expect(answers).toEqual([true, false]);
    expect(told).toEqual([22]);
  });
});
