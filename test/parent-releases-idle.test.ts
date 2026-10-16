import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshIdle,
  refreshParentReleases,
} from "../src/core/parent_releases.ts";

test("refreshIdle resolves at once with nothing in flight, and waits for a slow refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-idle-"));
  try {
    await refreshIdle(dir);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async () => {
      await gate;
      return Response.json({
        releases: [{ name: "1.0.0", url: "http://127.0.0.1/r" }],
      });
    }) as unknown as typeof fetch;
    void refreshParentReleases(dir, "http://127.0.0.1:1", {
      loopback: true,
      fetch: slow,
    });
    let idle = false;
    const waiting = refreshIdle(dir).then(() => (idle = true));
    await Bun.sleep(30);
    expect(idle).toBe(false);
    release();
    await waiting;
    expect(idle).toBe(true);
    const stored = JSON.parse(
      await Bun.file(join(dir, "parent-releases.json")).text(),
    );
    expect(stored.ok).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
