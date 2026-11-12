/**
 * A build stopped by its time, memory or CPU limit says which in one line,
 * and forge.json `limits.time` can lower the time, never past the ceiling.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breachLine, cellsAvailable, resolveLimits, STEP_TIME_MAX_MS, type CellSpec } from "../src/apps/contain.ts";
import type { AppManifest } from "../src/apps/manifest.ts";
import { parseCheck, parseManifest } from "../src/apps/manifest.ts";
import { childEnv, runStep, startProcess, stepLimits } from "../src/apps/process.ts";

const run = (command: string, build: ReturnType<typeof resolveLimits>, cell?: CellSpec, dir = tmpdir()) =>
  runStep("install", command, {
    cwd: dir,
    env: childEnv({}),
    log: () => {},
    signal: new AbortController().signal,
    cell,
    build,
  });

const cells = await cellsAvailable();

describe("build limits", () => {
  test("the default is 15 minutes and forge.json can lower it, not raise it past the ceiling", () => {
    expect(resolveLimits("step", undefined).timeMs).toBe(15 * 60_000);
    expect(resolveLimits("step", { timeMs: 60_000 }).timeMs).toBe(60_000);
    expect(resolveLimits("step", { timeMs: 10 * 3_600_000 }).timeMs).toBe(STEP_TIME_MAX_MS);
    expect(resolveLimits("app", undefined).timeMs).toBeUndefined();
    const m = parseManifest(JSON.stringify({ app: { run: "bun x.ts", limits: { time: 90 } } }), undefined);
    expect(m.ok && stepLimits({ manifest: m.value }).timeMs).toBe(90_000);
    expect(parseManifest(JSON.stringify({ app: { run: "bun x.ts", limits: { time: 0 } } }), undefined).ok).toBe(false);
    const chk = parseCheck(JSON.stringify({ check: { run: "bun test", limits: { time: 60 } } }), undefined);
    expect(chk.ok).toBe(false);
  });

  test("the app's running memory and cores do not reach its build", () => {
    const of = (limits: object) => {
      const m = parseManifest(JSON.stringify({ app: { run: "bun x.ts", limits } }), undefined);
      if (!m.ok) throw new Error("manifest");
      return stepLimits({ manifest: m.value });
    };
    const step = resolveLimits("step", undefined);
    expect(of({ memory: 128, cpus: 0.5 })).toMatchObject({ memoryMiB: step.memoryMiB, cpus: step.cpus });
    expect(of({ memory: 8192, cpus: 8 })).toMatchObject({ memoryMiB: step.memoryMiB, cpus: step.cpus });
  });

  test("a sleeping install past its time fails with the time sentence", async () => {
    const result = await run("sleep 30", resolveLimits("step", { timeMs: 1000 }));
    expect(result).toEqual({ ok: false, error: "the build used its 1 second" });
  }, 20_000);

  test("a deploy whose install runs past limits.time fails with the sentence", async () => {
    const dir = await mkdtemp(join(tmpdir(), "build-limits-"));
    try {
      const started = await startProcess({
        dir,
        dataDir: dir,
        manifest: { run: "sleep 1", install: "sleep 30", health: "/", ready: 8, limits: { timeMs: 1000 } } as AppManifest,
        env: "production",
        url: "http://app.test",
        commitOid: "0".repeat(40),
        forgeUrl: "http://forge.test",
        identityKey: "key",
        log: () => {},
        signal: new AbortController().signal,
      });
      expect(started.ok).toBe(false);
      if (!started.ok) expect(started.error.message).toContain("the build used its 1 second");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("the sentences for memory and cores", () => {
    const limits = resolveLimits("step", undefined);
    expect(breachLine("used 2100 MiB of memory, over its 2048 MiB limit (the default)", limits)).toBe(
      "the build ran out of its 2 GiB",
    );
    expect(breachLine("reached its 2048 MiB memory cap, and the kernel killed it", limits)).toBe(
      "the build ran out of its 2 GiB",
    );
    expect(breachLine("used 2.5 cores for 5s, over its limit of 2", limits)).toBe("the build used more than its 2 cores");
    expect(breachLine("something else", limits)).toBeUndefined();
  });

  test.skipIf(!cells.ok)("an install over its memory is stopped with the memory sentence (needs a cell)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "build-limits-"));
    try {
      const limits = { ...resolveLimits("step", undefined), memoryMiB: 128 };
      const spec: CellSpec = { dir, writable: [], home: join(dir, ".home"), hide: [], egress: [], reach: [], limits };
      const result = await run(
        `bun -e "const a = []; for (;;) { a.push(new Uint8Array(16 << 20).fill(1)); await Bun.sleep(10); }"`,
        limits,
        spec,
        dir,
      );
      expect(result).toEqual({ ok: false, error: "the build ran out of its 128 MiB" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
