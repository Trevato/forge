import { expect, test } from "bun:test";
import { watchDrill } from "../scripts/drills/watch.ts";

const reply = (status: number, body: string, type = "text/plain") => ({
  status,
  text: async () => body,
  headers: { get: (n: string) => (n === "content-type" ? type : null) },
});

function script(steps: Array<ReturnType<typeof reply> | Error>) {
  let i = 0;
  const slept: unknown[] = [];
  return {
    slept,
    fetch: async () => {
      const s = steps[Math.min(i++, steps.length - 1)]!;
      if (s instanceof Error) throw s;
      return s;
    },
    sleep: async (ms: number) => { slept.push(ms); },
  };
}

test("returns distinct lines said while unhealthy, with times, without waiting", async () => {
  const s = script([
    reply(200, "ok"),
    reply(503, "database locked\nretry 1"),
    new Error("refused"),
    reply(503, "database locked\nretry 2"),
    reply(200, "ok"),
  ]);
  const r = await watchDrill({ url: "http://x/", fetch: s.fetch, sleep: s.sleep, limit: 10 });
  expect(r).toEqual({ timeout: false, startedAt: 1000, healthyAt: 4000, lines: ["database locked", "retry 1", "unreachable"] });
  expect(s.slept.length).toBe(4);
});

test("reads JSON strings and strips control characters", async () => {
  const s = script([reply(500, JSON.stringify({ error: "bad\u001b[31m" }), "application/json"), reply(200, "ok")]);
  const r = await watchDrill({ url: "http://x/", fetch: s.fetch, sleep: s.sleep, limit: 5 });
  expect(r).toMatchObject({ timeout: false, lines: ["bad[31m"] });
});

test("times out when the forge never comes back, and when it never went down", async () => {
  const down = script([reply(503, "down")]);
  expect(await watchDrill({ url: "u", fetch: down.fetch, sleep: down.sleep, limit: 3 }))
    .toEqual({ timeout: true, startedAt: 0, lines: ["down"] });
  const up = script([reply(200, "ok")]);
  expect(await watchDrill({ url: "u", fetch: up.fetch, sleep: up.sleep, limit: 3 }))
    .toEqual({ timeout: true, startedAt: null, lines: [] });
});

test("a fetch that throws says 'unreachable'; an unreadable 5xx body says nothing but is still down", async () => {
  const bad = { status: 502, text: async () => { throw new Error("reset"); }, headers: { get: () => null } };
  const s = script([new Error("refused"), bad, reply(200, "ok")]);
  const seen: string[] = [];
  const r = await watchDrill({ url: "u", fetch: s.fetch, sleep: s.sleep, limit: 5, onLine: (l) => seen.push(l) });
  expect(r).toEqual({ timeout: false, startedAt: 0, healthyAt: 2000, lines: ["unreachable"] });
  expect(seen).toEqual(["unreachable"]);
});

test("an injected clock measures the times", async () => {
  const s = script([reply(503, "down"), reply(200, "ok")]);
  let t = 500;
  const r = await watchDrill({ url: "u", fetch: s.fetch, sleep: async () => { t += 1700; }, limit: 5, now: () => t });
  expect(r).toEqual({ timeout: false, startedAt: 0, healthyAt: 1700, lines: ["down"] });
});

test("the ceiling is time, not polls: slow polls time out long before the poll limit", async () => {
  let t = 0;
  let polls = 0;
  const r = await watchDrill({
    url: "u",
    fetch: async () => { polls++; t += 4_000; return reply(503, "down"); },
    sleep: async () => { t += 4_000; },
    limit: 1000,
    intervalMs: 1000,
    ceilingMs: 20_000,
    now: () => t,
  });
  expect(r).toEqual({ timeout: true, startedAt: 4_000, lines: ["down"] });
  expect(polls).toBe(3);
});
