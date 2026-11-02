/**
 * The egress tally keeps every byte per destination, not only what open
 * connections moved (#7546): counters that survive a closed connection, the
 * last hour minute by minute, a meter an install step reads, and a bound on
 * how many destinations it holds.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  egressSnapshot,
  egressTotals,
  meterEgress,
  NPM_REGISTRY,
  npmBytesLastHour,
  recordEgress,
  resetEgressTotals,
  startEgress,
} from "../src/apps/egress.ts";
import { installFetchedLine } from "../src/checks/install.ts";

// The tally is the process's own, and `bun test` runs many files in one
// process: a proxy test in a file before this one leaves its destinations
// behind, so each test starts from nothing, not only ends there.
beforeEach(resetEgressTotals);
afterEach(resetEgressTotals);

const T = Date.UTC(2026, 9, 27, 12, 0, 0);
const MIN = 60_000;

test("bytes add up per destination across labels", () => {
  recordEgress("check:a", NPM_REGISTRY, 1_000, 10, T);
  recordEgress("check:b", NPM_REGISTRY, 2_500, 5, T);
  expect(egressTotals(T)).toEqual([
    { destination: NPM_REGISTRY, bytesIn: 3_500, bytesOut: 15, bytesInLastHour: 3_500 },
  ]);
});

test("the last hour counts the 60 minutes up to now and drops older ones", () => {
  recordEgress("x", NPM_REGISTRY, 100, 0, T); // minute 0
  recordEgress("x", NPM_REGISTRY, 20, 0, T + 30 * MIN); // minute 30
  recordEgress("x", NPM_REGISTRY, 3, 0, T + 59 * MIN); // minute 59
  expect(npmBytesLastHour(T + 59 * MIN)).toBe(123);
  // At minute 60, minute 0 has left the window: 20 + 3.
  expect(npmBytesLastHour(T + 60 * MIN)).toBe(23);
  // Minute 60 reuses minute 0's slot and starts it from nothing.
  recordEgress("x", NPM_REGISTRY, 7, 0, T + 60 * MIN);
  expect(npmBytesLastHour(T + 60 * MIN)).toBe(30);
  expect(npmBytesLastHour(T + 200 * MIN)).toBe(0);
  // The counter never falls: 100 + 20 + 3 + 7.
  expect(egressTotals(T + 200 * MIN)[0]?.bytesIn).toBe(130);
});

test("no traffic to the registry reads 0", () => {
  recordEgress("x", "example.com:443", 9, 0, T);
  expect(npmBytesLastHour(T)).toBe(0);
});

test("destinations are bounded: past 256 the rest count as other", () => {
  for (let i = 0; i < 300; i++) recordEgress("x", `h${i}.example:443`, 1, 0, T);
  const totals = egressTotals(T);
  expect(totals.length).toBe(257);
  expect(totals.find((t) => t.destination === "other")?.bytesIn).toBe(44);
});

test("the registry keeps its own entry however many destinations came first", () => {
  for (let i = 0; i < 300; i++) recordEgress("x", `h${i}.example:443`, 1, 0, T);
  recordEgress("check:a", NPM_REGISTRY, 5_000, 0, T);
  expect(npmBytesLastHour(T)).toBe(5_000);
  expect(egressTotals(T).find((t) => t.destination === "other")?.bytesIn).toBe(44);
});

test("a meter counts its label from start to stop, and forgets the label after", () => {
  recordEgress("check:r", NPM_REGISTRY, 50, 0, T);
  const meter = meterEgress("check:r");
  recordEgress("check:r", NPM_REGISTRY, 400, 0, T);
  recordEgress("check:other", NPM_REGISTRY, 9_999, 0, T);
  expect(meter.stop()).toBe(400);
  // A second meter on the same label starts from nothing.
  const again = meterEgress("check:r");
  expect(again.stop()).toBe(0);
});

test("the install line reads 0 B on a warm cache", () => {
  expect(installFetchedLine(0)).toBe("install fetched 0 B from the registry");
  expect(installFetchedLine(12_345_678)).toBe("install fetched 12.3 MB from the registry");
  expect(installFetchedLine(-4096)).toBe("install fetched 0 B from the registry");
});

test("bytes through the proxy stay counted after the connection closes", async () => {
  const upstream = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(s) {
        s.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello");
      },
    },
  });
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const label = `check:totals-${port}`;
  const egress = startEgress({ tcp: port }, { hosts: [], origins: [{ host: "127.0.0.1", port: upstream.port }], label });
  const meter = meterEgress(label);
  try {
    // A raw socket: fetch goes straight to a loopback host, past any proxy.
    const answer = await new Promise<string>((resolve) => {
      let got = "";
      void Bun.connect<undefined>({
        hostname: "127.0.0.1",
        port,
        socket: {
          open(s) {
            s.write(`GET http://127.0.0.1:${upstream.port}/ HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
          },
          data(_s, chunk) {
            got += new TextDecoder().decode(chunk);
          },
          close() {
            resolve(got);
          },
        },
      });
    });
    expect(answer).toEndWith("hello");
    const destination = `127.0.0.1:${upstream.port}`;
    const end = Date.now() + 2_000;
    while (Date.now() < end && egressSnapshot().some((r) => r.label === label)) await Bun.sleep(20);
    expect(egressSnapshot().some((r) => r.label === label)).toBe(false);
    const total = egressTotals().find((t) => t.destination === destination);
    expect(total?.bytesIn).toBeGreaterThan(5);
    expect(total?.bytesOut).toBeGreaterThan(0);
    expect(meter.stop()).toBe(total?.bytesIn ?? -1);
  } finally {
    egress.close();
    upstream.stop(true);
  }
});
