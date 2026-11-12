/**
 * The child quota: what all children together may hold on this host. Declared
 * by FORGE_CHILD_CPUS, FORGE_CHILD_MEMORY_MIB and FORGE_CHILD_DISK_MIB; a
 * variable that is unset (or not a whole number above zero) declares no limit,
 * so test hosts and forges that never set them are never refused. Used is the
 * sum of the sizes in the spawn ledger (a ledger without a size reads small).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { floorRefusal } from "./disk_floor.ts";
import { DEFAULT_SIZE, isSize, SIZES, type Size, type SizeLimits } from "./sizes.ts";

interface Axis {
  readonly env: string;
  readonly key: keyof SizeLimits;
  readonly words: string;
  readonly unit: string;
}

const AXES: readonly Axis[] = [
  { env: "FORGE_CHILD_CPUS", key: "cpu", words: "CPU", unit: "" },
  { env: "FORGE_CHILD_MEMORY_MIB", key: "memoryMiB", words: "memory", unit: " MiB" },
  { env: "FORGE_CHILD_DISK_MIB", key: "diskMiB", words: "disk", unit: " MiB" },
];

function limitOf(env: Record<string, string | undefined>, name: string): number | undefined {
  const v = env[name];
  if (v === undefined || !/^[0-9]{1,9}$/.test(v)) return undefined;
  const n = Number(v);
  return n > 0 ? n : undefined;
}

/** What the children already made hold, summed from the ledger lines under `dataDir/spawn`. */
export function heldByChildren(dataDir: string): SizeLimits {
  const held = { cpu: 0, memoryMiB: 0, diskMiB: 0 };
  let files: string[] = [];
  try {
    files = readdirSync(join(dataDir, "spawn"));
  } catch {
    return held;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let size: Size = DEFAULT_SIZE;
    try {
      const s = (JSON.parse(readFileSync(join(dataDir, "spawn", f), "utf8")) as { size?: unknown }).size;
      if (isSize(s)) size = s;
    } catch {
      continue;
    }
    held.cpu += SIZES[size].cpu;
    held.memoryMiB += SIZES[size].memoryMiB;
    held.diskMiB += SIZES[size].diskMiB;
  }
  return held;
}

/** One sentence naming the first declared limit a child of this size would pass, or undefined. */
export function quotaRefusal(
  dataDir: string,
  size: Size,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  // The host's own floor comes first, declared limits or not (#10850).
  const floor = floorRefusal(dataDir);
  if (floor !== undefined) return floor;
  const limits = AXES.map((a) => ({ a, max: limitOf(env, a.env) })).filter((l) => l.max !== undefined);
  if (limits.length === 0) return undefined;
  const held = heldByChildren(dataDir);
  for (const { a, max } of limits) {
    if (held[a.key] + SIZES[size][a.key] > max!)
      return `a ${size} forge would pass this host's child ${a.words} limit (${a.env}=${max}${a.unit}; ${held[a.key]}${a.unit} already held)`;
  }
  return undefined;
}

/** Why even the smallest forge would not fit, or undefined: what the New forge page says before the form. */
export const quotaFull = (dataDir: string, env?: Record<string, string | undefined>): string | undefined =>
  quotaRefusal(dataDir, DEFAULT_SIZE, env);
