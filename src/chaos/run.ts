/**
 * One night of chaos on a side instance: boot a world in a fresh directory,
 * inject each fault in an order the seed chose, assert every invariant after
 * each. `bun src/chaos/run.ts [--seed N] [--report]` is the nightly; the
 * gate's `test/chaos.test.ts` calls `chaos` with fewer rounds.
 *
 * It refuses to be pointed at anything: the data directory is a new
 * temporary one, so the live forge and customers' apps are out of reach.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAULTS, type Fault } from "./faults.ts";
import { INVARIANTS } from "./invariants.ts";
import { fileReport, type Finding } from "./report.ts";
import { bootWorld } from "./world.ts";

/** mulberry32: a seed in, the same sequence out. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Night {
  readonly seed: number;
  readonly faults: readonly string[];
  readonly findings: readonly Finding[];
  readonly log: readonly string[];
}

export async function chaos(
  seed: number,
  rounds = FAULTS.length,
  faults: readonly Fault[] = FAULTS,
): Promise<Night> {
  const rand = rng(seed);
  const root = mkdtempSync(join(tmpdir(), "forge-chaos-"));
  const log: string[] = [];
  const findings: Finding[] = [];
  const order: string[] = [];
  try {
    const world = await bootWorld(join(root, "data"));
    try {
      for (let i = 0; i < rounds; i++) {
        const fault = faults[Math.floor(rand() * faults.length)]!;
        order.push(fault.name);
        log.push(`fault: ${fault.name}`);
        try {
          await fault.inject(world, rand);
        } catch (error) {
          findings.push({ fault: fault.name, broken: [`the fault itself failed: ${String(error)}`] });
          log.push(`  failed: ${String(error)}`);
          continue;
        }
        for (const invariant of INVARIANTS) {
          const broken = await invariant.check(world).catch((e) => [`check threw: ${String(e)}`]);
          log.push(`  ${broken.length === 0 ? "holds" : "BROKEN"}: ${invariant.name}`);
          if (broken.length > 0) findings.push({ fault: fault.name, broken: broken.map((b) => `${invariant.name}: ${b}`) });
        }
      }
    } finally {
      world.app.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { seed, faults: order, findings, log };
}

if (import.meta.main) {
  const flag = (name: string): string | undefined => {
    const at = process.argv.indexOf(name);
    return at === -1 ? undefined : process.argv[at + 1];
  };
  const seed = Number(flag("--seed") ?? Date.now() % 2 ** 32);
  const rounds = Number(flag("--rounds") ?? 12);
  const night = await chaos(seed, rounds);
  console.log(night.log.join("\n"));
  if (process.argv.includes("--report")) console.log(await fileReport(night));
  process.exit(night.findings.length === 0 ? 0 : 1);
}
