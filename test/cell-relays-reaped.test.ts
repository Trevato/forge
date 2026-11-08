/**
 * A cell's relays end with the cell (#3708). Every cell starts `socat`s
 * inside it — the proxy's front door, one per loopback port it may reach,
 * and the way in — and 255 socats alive in one pod was the question. Fifty
 * cells started and stopped leave not one of theirs behind.
 *
 * The relays are told apart from any other cell's on the machine by a
 * loopback port only this file asks for: `loop-<port>.sock` is in each
 * relay's command line.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CellSpec } from "../src/apps/contain.ts";
import { runStep } from "../src/apps/process.ts";
import { portInsteadOfSocket } from "../src/git/hook-address.ts";
import { missing } from "./helpers/tools.ts";

const noCells =
  process.env["FORGE_CELLS"] === "off" ||
  process.platform !== "linux" ||
  portInsteadOfSocket() ||
  missing("bwrap", "socat");

/** Live socat processes whose command line carries `mark`. */
function relays(mark: string): number[] {
  const out: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const state = stat.slice(stat.lastIndexOf(")") + 2)[0];
      if (state === "Z" || state === "X") continue;
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ");
      if (cmd.startsWith("socat ") && cmd.includes(mark)) out.push(Number(name));
    } catch {
      // gone mid-read
    }
  }
  return out;
}

describe.skipIf(noCells)("cells: no relay outlives its cell", () => {
  let dir: string;
  // A port nothing listens on: only the relay's command line needs it.
  const port = 40_000 + Math.floor(Math.random() * 20_000);
  const mark = `loop-${port}.sock`;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-relays-"));
  });
  afterAll(async () => {
    for (const pid of relays(mark))
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // gone
      }
    await rm(dir, { recursive: true, force: true });
  });

  const spec = (): CellSpec => ({
    dir,
    writable: [],
    home: join(dir, "home"),
    hide: [],
    egress: [],
    reach: [`http://127.0.0.1:${port}`],
    limits: { memoryMiB: 256, cpus: 1, diskMiB: 64 },
    listen: port + 1,
  });

  const step = (command: string) =>
    runStep("relays", command, {
      cwd: dir,
      env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
      log: () => {},
      signal: new AbortController().signal,
      timeoutMs: 30_000,
      cell: spec(),
    });

  test("a running cell's relays are visible to this count", async () => {
    const running = step("sleep 2");
    let seen = 0;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && seen === 0) {
      seen = relays(mark).length;
      await Bun.sleep(50);
    }
    if (seen === 0) throw new Error(`never came: still waiting while seen === 0`);
    const result = await running;
    expect(result.ok).toBe(true);
    expect(seen).toBeGreaterThan(0);
  }, 30_000);

  test("fifty cells started and stopped leave zero socat", async () => {
    for (let i = 0; i < 50; i++) {
      const result = await step("true");
      expect(result.ok).toBe(true);
    }
    // The namespace's processes go as its init does; give the kernel a beat.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && relays(mark).length > 0) await Bun.sleep(50);
    expect(relays(mark)).toEqual([]);
  }, 180_000);
});
