import { expect, test } from "bun:test";
import { WATCH, cellCounters, watchLabelled } from "../src/apps/contain.ts";

test("watchLabelled lists a plain process tree under its label until unwatched", async () => {
  const child = Bun.spawn(["sleep", "5"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  const unwatch = watchLabelled(child.pid, "crew:test");
  try {
    await Bun.sleep(WATCH.tickMs + 300);
    const found = cellCounters().filter((c) => c.label === "crew:test");
    expect(found.length).toBe(1);
    expect(found[0]!.memoryBytes).toBeGreaterThan(0);
  } finally {
    unwatch();
    child.kill();
  }
  expect(cellCounters().some((c) => c.label === "crew:test")).toBe(false);
});
