/**
 * The small chaos in the gate: every fault once, on a side instance in a
 * temporary directory, with every invariant asserted after each.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { FAULTS, slowProxy, type Fault } from "../src/chaos/faults.ts";
import { INVARIANTS, type Invariant } from "../src/chaos/invariants.ts";
import { issueFor, quietLine } from "../src/chaos/report.ts";
import { chaos, rng } from "../src/chaos/run.ts";
import { bootWorld, SEALED_VALUE, type World } from "../src/chaos/world.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = Number(process.env["CHAOS_SEED"] ?? 1244);

let root: string;
let world: World;

// The per-fault invariants; the snapshot one is costly and runs once per night.
const quick = INVARIANTS.filter((i) => i.final !== true);

// One world for the file. Faults share it, so after every test the cheap
// invariants are asserted: a test that leaves damage behind fails itself,
// not whichever test runs next.
afterEach(async () => {
  const broken = (await Promise.all(quick.map((i) => i.check(world)))).flat();
  expect(broken).toEqual([]);
});
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-chaos-"));
  world = await bootWorld(join(root, "data"));
});
afterAll(() => {
  world.app.close();
  rmSync(root, { recursive: true, force: true });
});

describe("chaos", () => {
  test("the rng repeats from a seed", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  const stub = (name: string): Fault => ({ name, inject: async () => {} });
  const stubs = [stub("a"), stub("b"), stub("c")];

  test("the same seed picks the same fault order", async () => {
    const a = await chaos(SEED, 5, stubs, { world, invariants: [] });
    const b = await chaos(SEED, 5, stubs, { world, invariants: [] });
    expect(a.faults).toHaveLength(5);
    expect(a.faults).toEqual(b.faults);
  });

  test("a final invariant is checked once after the last fault, the others every round", async () => {
    const events: string[] = [];
    const spy = (name: string, final: boolean): Invariant => ({
      name,
      ...(final ? { final: true as const } : {}),
      check: async () => {
        events.push(name);
        return [];
      },
    });
    const faults = stubs.map((f) => ({
      name: f.name,
      inject: async () => {
        events.push(`fault ${f.name}`);
      },
    }));
    const night = await chaos(SEED, 3, faults, { world, invariants: [spy("each", false), spy("last", true)] });
    expect(events.filter((e) => e === "last")).toHaveLength(1);
    expect(events.filter((e) => e === "each")).toHaveLength(3);
    expect(events.at(-1)).toBe("last");
    expect(events.lastIndexOf("each")).toBeLessThan(events.indexOf("last"));
    expect(night.findings).toEqual([]);
  });

  test("a broken final invariant is attributed to the last fault of the night", async () => {
    const broken: Invariant = { name: "snap", final: true, check: async () => ["gone"] };
    const night = await chaos(SEED, 4, stubs, { world, invariants: [broken] });
    expect(night.findings).toEqual([{ fault: night.faults[3]!, broken: ["snap: gone"] }]);
  });

  for (const fault of FAULTS) {
    test(`after "${fault.name}" every invariant holds (seed ${SEED})`, async () => {
      const night = await chaos(SEED, 1, [fault], { world, invariants: quick });
      expect(night.findings, `reproduce: CHAOS_SEED=${SEED}\n${night.log.join("\n")}`).toEqual([]);
    });
  }

  test("all faults in a seeded order, one after another", async () => {
    const night = await chaos(SEED, FAULTS.length, FAULTS, { world });
    expect(night.faults).toHaveLength(FAULTS.length);
    expect(night.findings, `reproduce: CHAOS_SEED=${SEED}\n${night.log.join("\n")}`).toEqual([]);
  });

  test("the slow proxy delays but delivers", async () => {
    const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    const proxy = slowProxy(backend.port!, 30);
    try {
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${proxy.port}/`, { headers: { connection: "close" } });
      expect(await res.text()).toBe("ok");
      expect(performance.now() - t0).toBeGreaterThanOrEqual(50);
    } finally {
      proxy.stop(true);
      backend.stop(true);
    }
  });

  test("an invariant catches what it guards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-chaos-neg-"));
    const side = await bootWorld(join(dir, "data"));
    try {
      side.app.db.query("DELETE FROM run WHERE id = ?1").run([...side.runIds][1]!);
      writeFileSync(join(side.dataDir, "leak.txt"), SEALED_VALUE);
      const broken = (await Promise.all(INVARIANTS.map((i) => i.check(side)))).flat();
      expect(broken.some((b) => b.includes("vanished"))).toBe(true);
      expect(broken.some((b) => b.includes("sealed value is readable"))).toBe(true);
    } finally {
      side.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a broken night makes an issue with fault, seed and log; a quiet one a line", () => {
    const night = {
      seed: 9,
      faults: ["f"],
      findings: [{ fault: "f", broken: ["run x vanished"] }],
      log: ["fault: f"],
    };
    const issue = issueFor(night);
    expect(issue.title).toContain("seed 9");
    expect(issue.body).toContain("run x vanished");
    expect(issue.body).toContain("--seed 9");
    expect(quietLine({ ...night, findings: [] })).toContain("every invariant held");
  });
});
