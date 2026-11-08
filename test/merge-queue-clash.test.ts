/**
 * The merge queue remembers what its searches found (#4235). Three pulls
 * where A and B clash — each green alone, red together — and C is fine:
 * the search lands A and C and hands B back once, remembered on top of A.
 * B joining again at the same head is re-checked alone, after the fresh
 * pulls and stacked on by nothing, so it never rides with A or with fresh
 * pulls again; a push forgets it. The gate here reads the candidate's
 * tree: red when it holds both `a.txt` and `b.txt`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batchWords, type Candidate, enqueue, type Expect, queueClashes, type Queued, redBatchRate, redMark } from "../src/checks/queue.ts";
import type { Pull } from "../src/core/pulls.ts";

describe("the merge queue remembers clashes", () => {
  let dir: string;
  /** Every gate: the pull numbers its candidate carried, and its verdict. */
  const gates: { pulls: number[]; ok: boolean }[] = [];
  /** Every hand-back: the pull, and the pulls it was red on top of. */
  const told: { pull: number; together: number[] }[] = [];

  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-merge-queue-clash-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A pull's head: one file added on main as it is now. */
  async function headAdding(branch: string, file: string): Promise<string> {
    // Off main, and reset to it: landings move main under the work tree.
    git("checkout", "-q", "-B", branch, "main");
    git("reset", "-q", "--hard", "main");
    await Bun.write(join(dir, file), `${file}\n`);
    git("add", file);
    git("commit", "-q", "-m", file);
    git("checkout", "-q", "--detach");
    return git("rev-parse", branch);
  }

  const gate = async (candidate: Candidate) => {
    const files = git("ls-tree", "--name-only", candidate.tipOid).split("\n");
    const ok = !(files.includes("a.txt") && files.includes("b.txt"));
    gates.push({ pulls: candidate.steps.map((s) => s.entry.pull.number), ok });
    return ok
      ? ({ lands: true } as const)
      : ({ lands: false, reopen: true, comment: "red", learn: [] } as const);
  };

  /** A queued pull that lands the way the forge does: only on the base it was gated on. */
  function entry(number: number, headOid: string): Queued {
    return {
      pull: { id: `clash-${number}`, number, baseBranch: "main", headOid } as Pull,
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

  const repoId = "clash-line";
  /** B red on its own merge on main as it is now: the mark names this base (#6493). */
  const markedNow = async () => {
    expect(await enqueue(repoId, [entry(2, git("rev-parse", "b"))], gate)).toEqual([false]);
  };
  const together = (a: number, b: number) => gates.filter((g) => g.pulls.includes(a) && g.pulls.includes(b)).length;

  test("A and B clash, C is fine: A and C land, B is handed back once on top of A", async () => {
    const [a, b, c] = [
      entry(1, await headAdding("a", "a.txt")),
      entry(2, await headAdding("b", "b.txt")),
      entry(3, await headAdding("c", "c.txt")),
    ];
    expect(await enqueue(repoId, [a, b, c], gate)).toEqual([true, false, true]);
    expect(told).toEqual([{ pull: 2, together: [1] }]);
    // The red candidate and the search's prefix that found it: never again.
    expect(together(1, 2)).toBe(2);
    expect(queueClashes(repoId)).toBe(1);
    expect(redBatchRate(repoId)).toEqual({ batches: 2, red: 1 });
    expect(git("ls-tree", "--name-only", "refs/heads/main").split("\n").sort()).toEqual(["a.txt", "c.txt"]);
  });

  test("B joining again at the same head is re-checked alone, after the fresh pulls, and cuts nothing off", async () => {
    await markedNow();
    const b = entry(2, git("rev-parse", "b"));
    const [d, e] = [entry(4, await headAdding("d", "d.txt")), entry(5, await headAdding("e", "e.txt"))];
    const before = gates.length;
    // B is first in line; the fresh pulls still gate first, together.
    expect(await enqueue(repoId, [b, d, e], gate, { depth: 2, room: () => 4 })).toEqual([false, true, true]);
    const mine = gates.slice(before);
    expect(mine).toEqual([
      { pulls: [4, 5], ok: true },
      { pulls: [2], ok: false },
    ]);
    expect(together(1, 2)).toBe(2);
    // Alone on main as it is now, B is red on its own merge.
    expect(told.at(-1)).toEqual({ pull: 2, together: [] });
    expect(queueClashes(repoId)).toBe(0);
    // A red re-check is no red batch; the fresh try before it was one.
    expect(redBatchRate(repoId)).toEqual({ batches: 4, red: 2 });
  });

  test("a fresh pull joining behind a re-check is not stacked on it", async () => {
    await markedNow();
    const b = entry(2, git("rev-parse", "b"));
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    const before = gates.length;
    let open = 0;
    const holding = async (candidate: Candidate) => {
      open++;
      await held;
      return gate(candidate);
    };
    const options = { depth: 2, room: () => 4 };
    const first = enqueue(repoId, [b], holding, options);
    for (let i = 0; i < 2000 && open < 1; i++) await Bun.sleep(5);
    if (open < 1) throw new Error(`never came: still waiting while open < 1`);
    const f = entry(6, await headAdding("f", "f.txt"));
    const second = enqueue(repoId, [f], holding, options);
    for (let i = 0; i < 40; i++) await Bun.sleep(5);
    // The fresh pull waits for the re-check rather than gate on top of it.
    expect(open).toBe(1);
    release();
    expect([...(await first), ...(await second)]).toEqual([false, true]);
    expect(gates.slice(before)).toEqual([
      { pulls: [2], ok: false },
      { pulls: [6], ok: true },
    ]);
  });

  test("red alone, then main moves: the pull gates again as a fresh entry", async () => {
    await markedNow();
    const h = entry(8, await headAdding("h", "h.txt"));
    expect(await enqueue(repoId, [h], gate)).toEqual([true]); // main moves
    const b = entry(2, git("rev-parse", "b"));
    const before = gates.length;
    // Fresh: it rides with the new pull in one candidate, not behind it as a re-check.
    const i = entry(9, await headAdding("i", "i.txt"));
    expect(await enqueue(repoId, [b, i], gate)).toEqual([false, true]);
    expect(gates.slice(before)[0]).toEqual({ pulls: [2, 9], ok: false });
  });

  test("red alone, main unmoved: the mark still holds it for a re-check", async () => {
    await markedNow();
    const before = gates.length;
    const j = entry(10, await headAdding("j", "j.txt"));
    const b = entry(2, git("rev-parse", "b"));
    expect(await enqueue(repoId, [b, j], gate)).toEqual([false, true]);
    expect(gates.slice(before)).toEqual([
      { pulls: [10], ok: true },
      { pulls: [2], ok: false },
    ]);
  });

  test("red alone is readable as a mark at its head and base, and nowhere else", async () => {
    await markedNow();
    const head = git("rev-parse", "b");
    const mark = redMark(repoId, "clash-2", head);
    expect(mark?.head).toBe(head);
    expect(mark?.base).toBe(git("rev-parse", "refs/heads/main"));
    expect(new Date(mark!.at).toISOString()).toBe(mark!.at);
    expect(redMark(repoId, "clash-2", "0".repeat(40))).toBeUndefined();
    expect(redMark(repoId, "clash-99", head)).toBeUndefined();
    expect(redMark("no-such-line", "clash-2", head)).toBeUndefined();
  });

  test("a push is a new head: B is forgotten, gated as a fresh pull, and lands", async () => {
    const pushed = entry(2, await headAdding("b2", "b2.txt"));
    const g = entry(7, await headAdding("g", "g.txt"));
    const before = gates.length;
    expect(await enqueue(repoId, [pushed, g], gate)).toEqual([true, true]);
    // Not a re-check: B goes first, as fresh. Its red batches halved this
    // line's batch to one (#6674); two greens in a row double it.
    expect(gates.slice(before)).toEqual([
      { pulls: [2], ok: true },
      { pulls: [7], ok: true },
    ]);
    expect(batchWords(repoId, 8)).toBe("2 of 8");
    expect(queueClashes(repoId)).toBe(0);
  });
});
