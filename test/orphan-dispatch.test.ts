import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { startCrew } from "../src/crew/dispatch.ts";

describe("the crew sweeps orphan clones", () => {
  test("at start it removes a leftover, and stop() clears the hourly timer", async () => {
    const dataDir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "orphan-crew-"));
    const orphan = join(dataDir, "crew", "ghost", "no-such-repo", "42");
    mkdirSync(orphan, { recursive: true });
    const app = createApp({ dataDir, port: 0 });

    const set = globalThis.setInterval;
    const clear = globalThis.clearInterval;
    const hourly: unknown[] = [];
    const cleared: unknown[] = [];
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const t = (set as (...a: unknown[]) => unknown)(fn, ms, ...rest);
      if (ms === 60 * 60_000) hourly.push(t);
      return t;
    }) as typeof setInterval;
    globalThis.clearInterval = ((t: unknown) => {
      cleared.push(t);
      return (clear as (t: unknown) => void)(t);
    }) as typeof clearInterval;
    let crew;
    try {
      crew = await startCrew(app, {
        forgeUrl: "http://127.0.0.1:1",
        localUrl: "http://127.0.0.1:1",
        binary: "/nonexistent/claude",
        concurrency: 1,
        budgetUsd: 1,
        runTimeoutMs: 60_000,
        networkRetryScale: 0,
        reviewBudgetMs: 1000,
      });
      for (let i = 0; i < 100 && existsSync(orphan); i++) await Bun.sleep(20);
      expect(existsSync(orphan)).toBe(false);
      expect(hourly.length).toBe(1);
      await crew.stop();
      expect(cleared).toContain(hourly[0]);
    } finally {
      globalThis.setInterval = set;
      globalThis.clearInterval = clear;
      await crew?.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
