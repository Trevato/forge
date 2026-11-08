import { expect, test } from "bun:test";
import { PORT_RETRIES, freePort, lostPort, onFreshPort } from "../src/kernel/port.ts";

test("lostPort reads the ways a runtime says the address is taken", () => {
  expect(lostPort("error: Failed to start server. Is port 3000 in use?")).toBe(true);
  expect(lostPort("EADDRINUSE")).toBe(true);
  expect(lostPort("TypeError: x is not a function")).toBe(false);
});

test("onFreshPort retries on a new port while the port is lost, then stops", async () => {
  const seen: number[] = [];
  const out = await onFreshPort(async (port) => {
    seen.push(port);
    return { result: seen.length, portLost: seen.length < 2 };
  });
  expect(out).toBe(2);
  expect(seen.length).toBe(2);

  let calls = 0;
  await onFreshPort(async () => ({ result: ++calls, portLost: true }));
  expect(calls).toBe(PORT_RETRIES + 1);
});

test("freePort answers a usable port number", async () => {
  const port = await freePort();
  expect(port).toBeGreaterThanOrEqual(1);
  expect(port).toBeLessThanOrEqual(65535);
});
