/**
 * What Chrome does when the only interface is loopback (#10631, first half of
 * #10619). `takeLook` runs inside `unshare -rn` with just `lo` up, against a
 * Bun server on 127.0.0.1. The test prints what happened and asserts only that
 * one of the two outcomes came back inside the budget — it proves the failure
 * (or its absence), it does not fix it. Skipped, by name and with the reason
 * printed, where unshare, ip, Chromium or namespace permission is missing.
 */
import { describe, expect, test } from "bun:test";
import { findChromium } from "../src/looks/capture.ts";

const BUDGET_MS = 30_000;
const CHILD = new URL("./look-loopback-only.child.ts", import.meta.url).pathname;

function missing(): string | undefined {
  if (process.platform !== "linux") return "not linux";
  if (Bun.which("unshare") === null) return "unshare is not installed";
  if (Bun.which("ip") === null) return "ip is not installed";
  if (findChromium() === undefined) return "no Chromium found";
  const probe = Bun.spawnSync(["unshare", "-rn", "ip", "link", "set", "lo", "up"], {
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
    why === undefined ? "answers with a picture or an error" : `skipped: ${why}`,
    async () => {
      const proc = Bun.spawn(
        [
          "unshare", "-rn", "sh", "-c",
          `ip link set lo up && exec "${process.execPath}" "${CHILD}"`,
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
      expect(line).toMatch(/^loopback-only look: (png \d+|error .+)$/);
    },
    BUDGET_MS + 5_000,
  );
});
