import { expect, test } from "bun:test";
import { runGitCapture } from "../src/git/env.ts";

test("an aborted signal kills a running git and reports it as timed out (#10730)", async () => {
  const stop = new AbortController();
  const started = performance.now();
  const run = runGitCapture(["-c", "alias.nap=!sleep 3 >/dev/null 2>&1 #", "nap"], { timeoutMs: 30_000, signal: stop.signal });
  setTimeout(() => stop.abort(), 100);
  const out = await run;
  expect(out.timedOut).toBe(true);
  expect(performance.now() - started).toBeLessThan(5_000);
});

test("a signal already aborted starts no git", async () => {
  const stop = new AbortController();
  stop.abort();
  const out = await runGitCapture(["-c", "alias.nap=!sleep 3 >/dev/null 2>&1 #", "nap"], { signal: stop.signal });
  expect(out.timedOut).toBe(true);
});
