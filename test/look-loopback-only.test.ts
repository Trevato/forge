/**
 * What Chrome does when the only interface is loopback (#10631, first half of
 * #10619). `takeLook` runs inside `unshare -rn` with just `lo` up, against a
 * Bun server on 127.0.0.1. The test prints what happened and requires a PNG
 * inside the budget (#10632). Where unshare, Chromium or namespace
 * permission is missing it is skipped, by name and with the reason printed;
 * inside the forge's check that gap fails instead, naming it (#10680).
 */
import { describe, expect, test } from "bun:test";
import { missingPrerequisite, verdict } from "./look-loopback-only.verdict.ts";

const BUDGET_MS = 30_000;
const CHILD = new URL("./look-loopback-only.child.ts", import.meta.url).pathname;

const decided = verdict(missingPrerequisite(), process.env);
if (decided.kind !== "run") console.log(decided.line);

describe("takeLook with only loopback up", () => {
  if (decided.kind === "fail") {
    test("answers with a picture: its prerequisites are missing in the check", () => {
      throw new Error(decided.line);
    });
  } else {
    (decided.kind === "run" ? test : test.skip)(
      decided.kind === "skip" ? `skipped: ${decided.line}` : "answers with a picture",
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
  }
});
