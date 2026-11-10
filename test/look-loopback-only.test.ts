/**
 * What Chrome does when the only interface is loopback (#10631, first half of
 * #10619). `takeLook` runs inside `unshare -rn` with just `lo` up, against a
 * Bun server on 127.0.0.1. The test prints what happened and requires a PNG
 * inside the budget (#10632). Skipped, by name and with the reason
 * printed, where unshare, Chromium or namespace permission is missing.
 */
import { describe, expect, test } from "bun:test";
import { findChromium } from "../src/looks/capture.ts";

const BUDGET_MS = 30_000;
const CHILD = new URL("./look-loopback-only.child.ts", import.meta.url).pathname;

function missing(): string | undefined {
  if (process.platform !== "linux") return "not linux";
  if (Bun.which("unshare") === null) return "unshare is not installed";
  if (findChromium() === undefined) return "no Chromium found";
  const probe = Bun.spawnSync(["unshare", "-rn", "true"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  if (probe.exitCode !== 0)
    return `cannot make a network namespace: ${probe.stderr.toString().trim().slice(0, 200)}`;
  return undefined;
}

const why = missing();
if (why !== undefined) console.log(`loopback-only look: skipped, ${why}`);

describe("takeLook with only loopback up", () => {
  (why === undefined ? test : test.skip)(
    why === undefined ? "answers with a picture" : `skipped: ${why}`,
    async () => {
      const proc = Bun.spawn(
        [
          "unshare", "-rn", process.execPath, CHILD,
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, BUDGET_MS);
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      clearTimeout(timer);
      if (timedOut) throw new Error(`loopback-only look: no answer within ${BUDGET_MS / 1000} s`);
      const line = out.split("\n").find((l) => l.startsWith("loopback-only look: "));
      console.log(line ?? `loopback-only look: error child printed nothing (${err.trim().slice(0, 300)})`);
      expect(line).toMatch(/^loopback-only look: png \d+$/);
      const away = out.split("\n").find((l) => l.startsWith("loopback-only away: "));
      console.log(away);
      expect(away).toMatch(/^loopback-only away: refused /);
    },
    BUDGET_MS + 5_000,
  );
});
