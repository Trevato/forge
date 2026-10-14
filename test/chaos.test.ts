/**
 * The small chaos in the gate: every fault once, on a side instance in a
 * temporary directory, with every invariant asserted after each.
 */
import { describe, expect, test } from "bun:test";
import { FAULTS, slowProxy } from "../src/chaos/faults.ts";
import { INVARIANTS } from "../src/chaos/invariants.ts";
import { issueFor, quietLine } from "../src/chaos/report.ts";
import { chaos, rng } from "../src/chaos/run.ts";
import { bootWorld, SEALED_VALUE } from "../src/chaos/world.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED = Number(process.env["CHAOS_SEED"] ?? 1244);

describe("chaos", () => {
  test("the rng repeats from a seed", () => {
    const a = rng(7);
    const b = rng(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  for (const fault of FAULTS) {
    test(`after "${fault.name}" every invariant holds (seed ${SEED})`, async () => {
      const night = await chaos(SEED, 1, [fault]);
      expect(night.findings, `reproduce: CHAOS_SEED=${SEED}\n${night.log.join("\n")}`).toEqual([]);
    }, 60_000);
  }

  test("all faults in a seeded order, one after another", async () => {
    const night = await chaos(SEED, 6);
    expect(night.findings, night.log.join("\n")).toEqual([]);
    expect(night.faults).toEqual((await chaos(SEED, 6)).faults);
  }, 120_000);

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
    const root = mkdtempSync(join(tmpdir(), "forge-chaos-neg-"));
    try {
      const world = await bootWorld(join(root, "data"));
      world.app.db.query("DELETE FROM run WHERE id = ?1").run([...world.runIds][1]!);
      writeFileSync(join(world.dataDir, "leak.txt"), SEALED_VALUE);
      const broken = (await Promise.all(INVARIANTS.map((i) => i.check(world)))).flat();
      expect(broken.some((b) => b.includes("vanished"))).toBe(true);
      expect(broken.some((b) => b.includes("sealed value is readable"))).toBe(true);
      world.app.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

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
