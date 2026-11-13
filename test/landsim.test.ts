/**
 * The landing simulator (`test/support/landsim.ts`): seeded, reproducible
 * scenarios of pulls landing, run through the real merge code against a real
 * bare repository and database, and checked after every step against what
 * landing promises: what was reviewed is what lands, nothing is lost silently,
 * what was checked is what landed.
 *
 * The quick run's seeds also cover the pair properties (order independence on seeds divisible by 4, additive
 * merges on seed % 4 == 1, determinism on seed % 16 == 2). `LANDSIM_SEEDS=n` runs n seeds instead of the quick few. A failure prints the
 * seed and the scenario as a script; `bun test/support/landsim.ts --from <seed>
 * --seeds 1 --shrink` cuts it down to the pulls and edits that matter.
 *
 * A violation class an open issue owns is listed in `KNOWN_VIOLATIONS`: the
 * corpus stays green with it, and `test.failing` below holds its minimal
 * reproducer, so the day the issue is fixed that test goes red and says to
 * remove the mark.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  additiveForkPair,
  applyEdits,
  authorshipKept,
  checkedIsLanded,
  createWorld,
  gateAttachesToHead,
  generate,
  knownIssue,
  landInOrder,
  noDroppedBlocksLand,
  noSilentLoss,
  report,
  reviewedIsLanded,
  runCorpus,
  script,
  seedCount,
  shrinkBy,
  type Edit,
  type Landing,
  type Scenario,
  type World,
} from "./support/landsim.ts";

/** Seeds in the quick run: what fits in the suite's budget on a loaded machine. */
const QUICK = 6;

describe("the landing simulator", () => {
  let world: World;
  beforeAll(async () => {
    world = await createWorld();
  }, 60_000);
  afterAll(async () => {
    await world.close();
  });

  test("a seeded corpus lands what was reviewed, apart from the violations an issue owns", async () => {
    const n = seedCount(QUICK);
    const corpus = await runCorpus(world, 1, n, 3);
    const unexpected = [...corpus.classes].filter(
      ([cls]) => knownIssue(cls) === undefined,
    );
    const lines = unexpected.map(
      ([cls, seeds]) =>
        `  ${cls} (seeds ${seeds.slice(0, 5).join(", ")}): ${corpus.messages.get(cls)}`,
    );
    expect(
      lines,
      `landsim found violations nothing owns (rerun one with: bun test/support/landsim.ts --from <seed> --seeds 1 --shrink):\n${lines.join("\n")}`,
    ).toEqual([]);
    expect(corpus.landed).toBeGreaterThan(0);
  }, 300_000);

  // #12104: when two changes add lines at the same place, a kept fork's landing keeps main's side only.
  // This holds the reproducer. It fails today; when the issue is fixed it passes, which fails the suite: remove `.failing`.
  test.failing(
    "two fork pulls that add lines at the end of one file both land, both sides present (#12104)",
    async () => {
      const done = await landInOrder(
        world,
        additiveForkPair(),
        [1, 2],
        "merge",
      );
      expect(done.refused).toEqual([]);
      expect(
        done.outcome.violations.map((v) => `${v.cls}: ${v.message}`),
      ).toEqual([]);
    },
    120_000,
  );

});

describe("the simulator's own parts", () => {
  test("a seed is one scenario, and a scenario prints as a script that names it", () => {
    expect(generate(31)).toEqual(generate(31));
    expect(generate(31)).not.toEqual(generate(32));
    const text = script(generate(31));
    expect(text).toContain("seed 31");
    expect(text).toContain("settle");
  });

  test("two hundred seeds reach every kind of edit and every kind of step", () => {
    const edits = new Set<string>();
    const ops = new Set<string>();
    let forks = 0;
    let stacked = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const sc = generate(seed);
      for (const p of sc.pulls) {
        for (const e of p.edits) edits.add(e.k);
        if (p.fork) forks++;
        if (p.stackedOn !== undefined) stacked++;
      }
      for (const s of sc.steps) ops.add(s.op);
    }
    expect([...edits].sort()).toEqual([
      "addfile",
      "anchor",
      "append",
      "delete",
      "hunks",
      "line",
      "list",
      "mode",
      "rename",
      "space",
    ]);
    expect([...ops].sort()).toEqual([
      "approve",
      "check",
      "contain",
      "hook",
      "land",
      "main",
      "open",
      "refresh",
      "settle",
      "sweep",
    ]);
    expect(forks).toBeGreaterThan(50);
    expect(stacked).toBeGreaterThan(5);
  });

  test("edits resolve against the tree they meet, and skip what is gone", () => {
    const tree = new Map([
      ["a.ts", { content: "one ~x.1\ntwo ~x.2\n", mode: "100644" as const }],
    ]);
    const append: Edit = { k: "append", file: "a.ts", tag: "t", n: 1 };
    const writes = applyEdits(tree, [
      append,
      { k: "delete", file: "gone.ts" },
      { k: "mode", file: "missing.ts" },
    ]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.content).toBe(
      "one ~x.1\ntwo ~x.2\nexport const v_t_0 = 1; // ~t.0\n",
    );
    expect(applyEdits(tree, [{ k: "delete", file: "a.ts" }])).toEqual([
      { path: "a.ts", content: null },
    ]);
  });

  /** A landing that satisfies every invariant; each test below breaks one thing. */
  const clean: Landing = {
    pull: 1,
    origin: "fork",
    author: { name: "erin", email: "erin@x" },
    how: "merge",
    base: "b",
    head: "h",
    mergeBase: "m",
    landed: "c",
    baseTree: "t0",
    landedTree: "t1",
    before: new Set(["old ~1", "gone ~2"]),
    after: new Set(["old ~1", "new ~3"]),
    added: ["new ~3"],
    removed: ["gone ~2"],
    commits: [
      {
        oid: "c",
        name: "alice",
        email: "alice@x",
        body: "Co-authored-by: erin <erin@x>",
        parents: 2,
      },
    ],
    checkedTrees: new Set(["t1"]),
    approvedAtHead: true,
    greenAtHead: true,
    modesLost: [],
  };
  const withAfter = (...lines: string[]): Landing => ({
    ...clean,
    after: new Set(lines),
  });

  test("each invariant passes a clean landing and names what it finds", () => {
    for (const check of [
      reviewedIsLanded,
      noDroppedBlocksLand,
      noSilentLoss,
      checkedIsLanded,
      gateAttachesToHead,
      authorshipKept,
    ])
      expect(check(clean)).toEqual([]);
    // a reviewed line that never reached main
    expect(reviewedIsLanded(withAfter("old ~1"))[0]?.message).toContain(
      "new ~3",
    );
    // a line the pull removed that is still there
    expect(
      reviewedIsLanded(withAfter("old ~1", "new ~3", "gone ~2"))[0]?.cls,
    ).toContain("removed-line-survives");
    // a line main had, nobody removed, that is gone
    expect(noSilentLoss(withAfter("new ~3"))[0]?.message).toContain("old ~1");
    // a dropped block says so in its trailer
    const kept: Landing = {
      ...clean,
      commits: [{ ...clean.commits[0]!, body: "Combined-Kept: main 1 a.ts" }],
    };
    expect(noDroppedBlocksLand(kept)).toHaveLength(1);
    expect(
      reviewedIsLanded({ ...kept, after: new Set(["old ~1"]) })[0]?.cls,
    ).toBe("reviewedIsLanded/dropped-by-combine");
    // a tree no check ran on, an approval of an older head, a placeholder author
    expect(
      checkedIsLanded({ ...clean, checkedTrees: new Set(["t9"]) }),
    ).toHaveLength(1);
    expect(
      gateAttachesToHead({ ...clean, approvedAtHead: false }),
    ).toHaveLength(1);
    expect(
      authorshipKept({
        ...clean,
        commits: [
          { ...clean.commits[0]!, name: "forge", email: "forge@localhost" },
        ],
      })[0]?.cls,
    ).toBe("authorshipKept/placeholder");
    expect(
      authorshipKept({
        ...clean,
        commits: [{ ...clean.commits[0]!, body: "" }],
      }),
    ).toHaveLength(1);
  });

  test("a violation class an issue owns is known by its prefix, and nothing else is", () => {
    expect(knownIssue("reviewedIsLanded/dropped-by-combine")).toBe("#12104");
    expect(knownIssue("noSilentLoss/dropped-by-combine")).toBe("#12104");
    expect(knownIssue("reviewedIsLanded/dropped-repo-squash")).toBeUndefined();
    expect(knownIssue("determinism/history-differs")).toBeUndefined();
  });

  test("the shrinker drops pulls, steps, edits and files while the failure stays, and stops at its budget", async () => {
    const base = generate(5);
    // A made-up failure: it holds while pull #2 still has an edit tagged `p2e0` and the scenario is not empty.
    const culprit = (sc: Scenario): boolean =>
      sc.pulls.some(
        (p) =>
          p.id === 2 && p.edits.some((e) => "tag" in e && e.tag === "p2e0"),
      );
    const tagged: Scenario = {
      ...base,
      pulls: base.pulls.map((p) =>
        p.id === 2
          ? {
              ...p,
              edits: [
                { k: "append", file: "README.md", tag: "p2e0", n: 1 },
                ...p.edits,
              ],
            }
          : p,
      ),
    };
    let runs = 0;
    const small = await shrinkBy(
      async (sc) => (runs++, culprit(sc)),
      tagged,
      200,
    );
    expect(culprit(small)).toBe(true);
    expect(small.pulls.map((p) => p.id)).toEqual([2]);
    expect(small.pulls[0]!.edits).toHaveLength(1);
    expect(
      small.steps.every((s) => s.op === "settle" || ("p" in s && s.p === 2)),
    ).toBe(true);
    expect(Object.keys(small.files)).toHaveLength(1);
    expect(
      report(small, [{ invariant: "x", cls: "x/y", step: 1, message: "boom" }]),
    ).toContain("VIOLATION [x/y] at step 1: boom");
    const before = runs;
    await shrinkBy(async () => (runs++, true), tagged, 5);
    expect(runs - before).toBeLessThanOrEqual(5);
  });
});
