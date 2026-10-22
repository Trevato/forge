/**
 * Letting go of a deployment (#4496): `apps/handoff.ts` counts what the
 * proxy has in flight per port, closes its sockets with 1012 and waits —
 * bounded — for its requests; and `/readyz` waits for the apps a boot
 * started, bounded too.
 */

import { afterEach, expect, test } from "bun:test";
import { drainPort, holdPortRequest, holdPortSocket, inFlight, SERVICE_RESTART } from "../src/apps/handoff.ts";
import { health, readyResponse, STARTING_BUDGET_MS, startWarming } from "../src/http/health.ts";
import { createLog } from "../src/kernel/log.ts";

afterEach(() => {
  health.starting = undefined;
  health.startingSince = undefined;
  health.draining = false;
});

test("a port with nothing in flight drains at once", async () => {
  expect(await drainPort(40001, 5_000)).toBe(0);
});

test("draining closes every socket with 1012 and waits for the request still being answered", async () => {
  const closes: [number, string][] = [];
  const socket = { close: (code: number, reason: string) => void closes.push([code, reason]) };
  const releaseSocket = holdPortSocket(40002, socket);
  const answered = holdPortRequest(40002);
  expect(inFlight(40002)).toEqual({ requests: 1, sockets: 1 });

  let drained = false;
  const draining = drainPort(40002, 10_000).then((left) => {
    drained = true;
    return left;
  });
  await Bun.sleep(100);
  expect(closes).toEqual([[SERVICE_RESTART, "service restart"]]);
  expect(drained).toBe(false);
  answered();
  answered(); // a second release does nothing
  expect(await draining).toBe(0);
  releaseSocket();
  expect(inFlight(40002)).toEqual({ requests: 0, sockets: 0 });
});

test("a request that never answers holds the drain only for its budget, and is counted", async () => {
  const hung = holdPortRequest(40003);
  expect(await drainPort(40003, 300)).toBe(1);
  hung();
});

test("readiness waits for the apps a boot is starting, and says how many", () => {
  let starting = 2;
  const now = Date.now();
  startWarming(createLog("test"), () => starting, now);
  const waiting = readyResponse(now + 1_000);
  expect(waiting.status).toBe(503);
  starting = 1;
  expect(readyResponse(now + 2_000).status).toBe(503);
  starting = 0;
  expect(readyResponse(now + 3_000).status).toBe(200);
  // Over for good: an app redeploying later never makes the forge unready.
  starting = 1;
  expect(readyResponse(now + 4_000).status).toBe(200);
});

test("readiness waits no longer than its budget for an app that never comes up", async () => {
  const now = Date.now();
  startWarming(createLog("test"), () => 1, now);
  const before = readyResponse(now + STARTING_BUDGET_MS - 1);
  expect(before.status).toBe(503);
  expect(await before.text()).toBe("starting 1 app");
  expect(readyResponse(now + STARTING_BUDGET_MS).status).toBe(200);
});

test("nothing to start is ready at once, and draining is never ready", () => {
  startWarming(createLog("test"), () => 0);
  expect(health.starting).toBeUndefined();
  expect(readyResponse().status).toBe(200);
  health.draining = true;
  expect(readyResponse().status).toBe(503);
});
