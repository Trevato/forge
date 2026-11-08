/**
 * A live screen's refresh that throws at once, as a reload does when the
 * forge has closed under it, fails quietly: never an uncaught error on the
 * timer, which bun pins on whatever test runs next.
 */
import { expect, test } from "bun:test";
import { live } from "../src/tui/screens/common.ts";
import type { Session } from "../src/tui/session.ts";

test("a refresh that throws synchronously raises nothing uncaught", async () => {
  let fire: (event: unknown) => void = () => undefined;
  const session = { app: { bus: { subscribe: (fn: (event: unknown) => void) => ((fire = fn), () => undefined) } } } as unknown as Session;
  const uncaught: unknown[] = [];
  const note = (e: unknown) => uncaught.push(e);
  process.on("uncaughtException", note);
  let calls = 0;
  try {
    live(session, new AbortController().signal, {}, () => {
      calls++;
      throw new RangeError("Cannot use a closed database");
    });
    fire({ kind: "issue.opened", repoId: "r" });
    await Bun.sleep(100);
  } finally {
    process.off("uncaughtException", note);
  }
  expect(calls).toBe(1);
  expect(uncaught).toEqual([]);
});
