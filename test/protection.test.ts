import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  noteProtection,
  protectionNotice,
  resetProtection,
} from "../src/kernel/protection.ts";

afterEach(resetProtection);

test("a fully protected forge has no notice", () => {
  noteProtection("apps", { ok: true });
  expect(protectionNotice()).toBeUndefined();
});

test("a part that lacks protection is named with its reason, in one line", () => {
  noteProtection("apps", { ok: false, reason: "bwrap is not installed" });
  noteProtection("crew shells", { ok: false, reason: "no sandbox on win32" });
  const line = protectionNotice()!;
  expect(line).toContain("apps (bwrap is not installed)");
  expect(line).toContain("crew shells (no sandbox on win32)");
  expect(line).not.toContain("\n");
});

test("a part that recovers clears its own line", () => {
  noteProtection("apps", { ok: false, reason: "x" });
  noteProtection("apps", { ok: true });
  expect(protectionNotice()).toBeUndefined();
});

// Run in a process of its own: the probes are cached per process, and the
// host is made to refuse by its environment (`FORGE_CELLS=off`, no
// `bwrap` on an empty `PATH`), so removing either `noteProtection` call
// from `AppsRuntime.start` or `startCrew` turns this red.
test("AppsRuntime.start and startCrew each note what they lack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-protection-"));
  try {
    const script = `
        import { createApp } from "./src/app.ts";
        import { AppsRuntime } from "./src/apps/runtime.ts";
        import { startCrew } from "./src/crew/dispatch.ts";
        import { protectionNotice } from "./src/kernel/protection.ts";
        const app = createApp({ dataDir: ${JSON.stringify(dir)}, port: 0 });
        const runtime = new AppsRuntime(app, {
          domain: "apps.test", scheme: "http", publicPort: 0,
          forgeUrl: "http://127.0.0.1:1",
        });
        await runtime.start();
        const afterApps = protectionNotice();
        const crew = await startCrew(app, {
          forgeUrl: "http://127.0.0.1:1", localUrl: "http://127.0.0.1:1",
          binary: "/no/such/claude", concurrency: 1, budgetUsd: 1,
          runTimeoutMs: 60000,
        });
        console.log(JSON.stringify({ afterApps, afterCrew: protectionNotice() }));
        await crew.stop();
        await runtime.stop();
        process.exit(0);
      `;
    const run = Bun.spawnSync([process.execPath, "-e", script], {
      env: { FORGE_CELLS: "off", PATH: "", HOME: dir, TMPDIR: dir },
      cwd: join(import.meta.dir, ".."),
    });
    const out = run.stdout.toString().trim().split("\n").pop() ?? "";
    const seen = JSON.parse(out) as { afterApps: string; afterCrew: string };
    expect(seen.afterApps).toContain("apps (FORGE_CELLS=off)");
    expect(seen.afterApps).not.toContain("crew shells");
    if (process.platform === "linux")
      expect(seen.afterCrew).toContain("crew shells (bwrap is not installed)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
