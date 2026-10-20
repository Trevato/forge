/**
 * Checks at once and shards per check default to what the pod's CPUs hold
 * (#2549): shards `min(4, cpus)`, checks `floor(cpus / (shards × 3))` held
 * to 1–16, so the vxrail's 80 cores need no override and the sentinel no
 * longer calls 4 shards and 6 checks away from their defaults.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import {
  CAPACITY,
  CAPACITY_KEYS,
  bootDefault,
  capacityDefault,
  capacityEnv,
  capacityValue,
  checksForCpus,
  cpuLimit,
  provideCpusForTest,
  setCapacity,
  shardsForCpus,
} from "../src/core/capacity.ts";
import { changedOf } from "../src/actions/capacity.ts";
import { createUser } from "../src/core/users.ts";

const ENV = ["FORGE_CHECK_SHARDS", "FORGE_CHECKS_CONCURRENCY"] as const;
const saved = ENV.map((k) => process.env[k]);
afterEach(() => {
  ENV.forEach((k, i) => {
    if (saved[i] === undefined) delete process.env[k];
    else process.env[k] = saved[i];
  });
  provideCpusForTest(4);
});

describe("the defaults follow the CPUs", () => {
  // By hand: shards = min(4, cpus); checks = floor(cpus / (shards * 3)), 1..16.
  test.each([
    // cpus, shards, checks
    [4, 4, 1], // 4 / 12 = 0.33 → held to 1
    [16, 4, 1], // 16 / 12 = 1.33 → 1
    [80, 4, 6], // 80 / 12 = 6.67 → 6
    [2, 2, 1], // 2 / 6 = 0.33 → 1
    [1, 1, 1],
    [1000, 4, 16], // 1000 / 12 = 83 → held to 16
  ])("%d CPUs: %d shards, %d checks at once", (cpus, shards, checks) => {
    expect(shardsForCpus(cpus)).toBe(shards);
    expect(checksForCpus(cpus)).toBe(checks);
    delete process.env.FORGE_CHECK_SHARDS;
    delete process.env.FORGE_CHECKS_CONCURRENCY;
    expect(capacityDefault("checks.shards", cpus)).toBe(String(shards));
    expect(capacityDefault("checks.concurrency", cpus)).toBe(String(checks));
    provideCpusForTest(cpus);
    expect(capacityDefault("checks.shards")).toBe(String(shards));
    expect(capacityDefault("checks.concurrency")).toBe(String(checks));
  });

  test("the environment still wins over the CPUs", () => {
    process.env.FORGE_CHECK_SHARDS = "8";
    process.env.FORGE_CHECKS_CONCURRENCY = "3";
    expect(capacityDefault("checks.shards", 80)).toBe("8");
    expect(capacityDefault("checks.concurrency", 80)).toBe("3");
  });

  test("both help lines say how the default is reached", () => {
    expect(CAPACITY["checks.shards"].help).toContain("at most 4");
    expect(CAPACITY["checks.concurrency"].help).toContain("shards × 3");
  });
});

describe("a stored value overrides the default; the capacity page compares with it", () => {
  test("80 CPUs: 4 shards and 6 checks are the defaults, 8 shards is away", async () => {
    delete process.env.FORGE_CHECK_SHARDS;
    delete process.env.FORGE_CHECKS_CONCURRENCY;
    provideCpusForTest(80);
    const dataDir = await mkdtemp(join(tmpdir(), "forge-capacity-cpus-"));
    const app = createApp({ dataDir, port: 0 });
    try {
      const a = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      expect(capacityValue(app.db, "checks.shards")).toBe("4");
      expect(capacityEnv(app.db)).toEqual({ FORGE_CHECK_SHARDS: "4" });
      // A check's cell of 2 CPUs is given 2, not the pod's 4.
      expect(capacityEnv(app.db, 2)).toEqual({ FORGE_CHECK_SHARDS: "2" });

      // The owner's choice for the vxrail, set more than a day ago.
      setCapacity(app.db, "checks.shards", "4", a.value.id);
      setCapacity(app.db, "checks.concurrency", "6", a.value.id);
      setCapacity(app.db, "crew.concurrency", "5", a.value.id);
      const old = new Date(Date.now() - 3 * 24 * 3600_000).toISOString();
      app.db.query("UPDATE forge_setting SET updated_at = ?1").run(old);
      expect(CAPACITY_KEYS.filter((k) => changedOf(app.db, k).changed !== undefined)).toEqual(["crew.concurrency"]);

      // A stored value overrides the default, even a cell's smaller one.
      setCapacity(app.db, "checks.shards", "8", a.value.id);
      app.db.query("UPDATE forge_setting SET updated_at = ?1").run(old);
      expect(capacityValue(app.db, "checks.shards")).toBe("8");
      expect(capacityEnv(app.db, 2)).toEqual({ FORGE_CHECK_SHARDS: "8" });
      expect(changedOf(app.db, "checks.shards").changed?.by).toBe("alice");
      expect(bootDefault(app.db, "checks.shards")).toBe("4");
    } finally {
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

describe("cpuLimit reads the pod's cgroup", () => {
  const withFile = async (text: string | undefined, run: (file: string) => void) => {
    provideCpusForTest(undefined);
    const dir = await mkdtemp(join(tmpdir(), "forge-cpu-max-"));
    const file = join(dir, "cpu.max");
    if (text !== undefined) writeFileSync(file, text);
    try {
      run(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  const machine = availableParallelism();

  test("quota over period, rounded down, never more than the machine", async () => {
    await withFile("150000 100000\n", (f) => expect(cpuLimit(f)).toBe(Math.min(machine, 1)));
    await withFile("50000 100000\n", (f) => expect(cpuLimit(f)).toBe(1));
    await withFile(`${machine * 100000} 100000\n`, (f) => expect(cpuLimit(f)).toBe(machine));
    await withFile(`${machine * 200000} 100000\n`, (f) => expect(cpuLimit(f)).toBe(machine));
  });

  test("no quota, garbage or an unreadable file falls back to the machine", async () => {
    await withFile("max 100000\n", (f) => expect(cpuLimit(f)).toBe(machine));
    await withFile("nonsense", (f) => expect(cpuLimit(f)).toBe(machine));
    await withFile(undefined, (f) => expect(cpuLimit(f)).toBe(machine));
  });
});
