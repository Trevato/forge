/**
 * /forges side by side (#2933): size, use against size ("shared" for a
 * hosted child), apps and last heartbeat; an admin's only.
 */

import { describe, expect, test } from "bun:test";
import { forgeUse, mibWords, useWords } from "../src/spawn/usage.ts";
import { watchLabelled, cellCounters, coresOf, WATCH } from "../src/apps/contain.ts";
import type { Child } from "../src/actions/spawn.ts";
import { forgesPage, sideBySide } from "../src/web/pages/forges.ts";
import { createApp } from "../src/app.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const child = (over: Partial<Child>): Child => ({
  name: "serious", url: "https://serious.test", bodyId: "b", done: true, for: null, apps: [],
  createdAt: null, size: "medium", placement: "hosted", placementNote: null, ...over,
});

describe("what a forge uses against its size", () => {
  test("a hosted child shares this forge's process", () => {
    const u = forgeUse(child({}));
    expect(u).toEqual({ kind: "shared" });
    expect(useWords(u)).toEqual({ memory: "shared", cpu: "shared", disk: "shared" });
  });
  test("a cell that is not running says so, with its size's figures", () => {
    const u = forgeUse(child({ placement: "cell", name: "nobody-home" }));
    expect(u.kind).toBe("idle");
    expect(useWords(u).memory).toBe("not running");
  });
  test("a running cell reads its memory off the watch", async () => {
    const stop = watchLabelled(process.pid, "forge:fun");
    try {
      const wait = Date.now() + 3000;
      while (!cellCounters().some((c) => c.label === "forge:fun") && Date.now() < wait) await Bun.sleep(50);
      if (!cellCounters().some((c) => c.label === "forge:fun")) throw new Error(`never came: still waiting while !cellCounters().some((c) => c.label === "forge:fun")`);
      const dir = mkdtempSync(join(tmpdir(), "forge-sbs-d-"));
      const first = forgeUse(child({ placement: "cell", name: "fun", size: "small" }), dir);
      // The request never walks the disk: the first reading says so, a later one has the figure.
      expect(first.kind === "cell" && first.diskMiB).toBeNull();
      await Bun.sleep(100);
      const u = forgeUse(child({ placement: "cell", name: "fun", size: "small" }), dir);
      expect(u.kind === "cell" && u.diskMiB).not.toBeNull();
      expect(forgeUse(child({ placement: "cell", name: "fun" })).kind === "cell").toBe(true);
      expect(u.kind).toBe("cell");
      if (u.kind === "cell") {
        expect(u.memoryMiB).toBeGreaterThan(0);
        expect(useWords(u).memory).toMatch(/ of 512 MiB$/);
      }
    } finally {
      stop();
    }
  });
  test("figures in words", () => {
    expect(mibWords(512)).toBe("512 MiB");
    expect(mibWords(8192)).toBe("8 GiB");
  });
});

describe("GET /forges", () => {
  test("anyone but an admin gets not_found", async () => {
    const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), "forge-sbs-")), url: "https://x.test", port: 0 });
    const request = new Request("https://x.test/forges");
    const res = await forgesPage({ app, request, auth: { user: undefined }, params: {}, url: new URL(request.url) } as never);
    expect(res.status).toBe(404);
  });
});

describe("coresOf", () => {
  const samples = [{ at: 0, ticks: 0 }];
  test("null before the samples span half the window, a figure after", () => {
    expect(coresOf(samples, { ticks: 500 }, WATCH.cpuWindowMs / 2 - 1)).toBeNull();
    expect(coresOf([], { ticks: 500 }, 99_999)).toBeNull();
    expect(coresOf(samples, undefined, 99_999)).toBeNull();
    // 1500 ticks at 100/s over 30 s is half a core.
    expect(coresOf(samples, { ticks: 1500 }, 30_000)).toBeCloseTo(0.5, 5);
  });
});

describe("the table", () => {
  const base = { name: "fun", url: "https://fun.test", apps: [], lastHeartbeatAt: null } as never;
  test("a cell that is not running says so under each use column; one running reads X of Y", () => {
    const idle = String(sideBySide([{ ...(base as object), size: "small", use: { kind: "idle", limits: { cpu: 1, memoryMiB: 512, diskMiB: 2048 } } } as never]));
    expect(idle).toContain('data-use="idle"');
    expect(idle.match(/<td>not running<\/td>/g)).toHaveLength(3);
    const live = String(sideBySide([{ ...(base as object), size: "small", lastHeartbeatAt: new Date().toISOString(), use: { kind: "cell", limits: { cpu: 1, memoryMiB: 512, diskMiB: 2048 }, memoryMiB: 310, cores: null, diskMiB: null } } as never]));
    expect(live).toContain("<td>310 MiB of 512 MiB</td>");
    expect(live).toContain("<td>of 1 core</td>");
    expect(live).toContain("<td>measuring · 2 GiB</td>");
    expect(live).toContain("just now");
    expect(live).toContain('role="region" tabindex="0" aria-label="Forges side by side"');
    expect(live).toContain("data-sticky-lead");
  });
});
