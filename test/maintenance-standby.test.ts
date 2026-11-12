import { afterAll, expect, test } from "bun:test";
import { maintenanceHtml, MAINTENANCE_HEADERS } from "../src/maintenance/page.ts";
import type { Status } from "../src/maintenance/service.ts";
import { forgetStandby, probeStandby, readCapped, withStandby, standbyUrl, statusWithStandby, STANDBY_START } from "../src/maintenance/standby.ts";

const standby = Bun.serve({ port: 0, fetch: () => new Response(maintenanceHtml(), { status: 503, headers: MAINTENANCE_HEADERS }) });
const wrong = Bun.serve({ port: 0, fetch: () => new Response("<h1>forge</h1>", { status: 200 }) });
afterAll(() => {
  standby.stop(true);
  wrong.stop(true);
});

const ready: Status = { phase: "ready", working: 0, says: "Ready: releases are held. The host can power off." };

test("unset: says how to start one", async () => {
  expect(standbyUrl({})).toBeUndefined();
  expect(standbyUrl({ MAINTENANCE_STANDBY_URL: "file:///etc/passwd" })).toBeUndefined();
  const p = await probeStandby(undefined);
  expect(p.state).toBe("unset");
  expect(p.says).toBe(STANDBY_START);
  expect(p.says).toContain("bun scripts/standby.ts 8080");
  expect((await statusWithStandby(ready, async () => p)).says).toStartWith("Ready, no standby");
});

test("answering: 503 with the maintenance page", async () => {
  const p = await probeStandby(`http://127.0.0.1:${standby.port}/`);
  expect(p.state).toBe("answering");
  const s = await statusWithStandby(ready, async () => p);
  expect(s.says).toStartWith("Ready, standby answering");
  expect(s.standby.state).toBe("answering");
});

test("not answering: wrong status, nothing listening", async () => {
  expect((await probeStandby(`http://127.0.0.1:${wrong.port}/`)).state).toBe("not_answering");
  const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = dead.port;
  dead.stop(true);
  const p = await probeStandby(`http://127.0.0.1:${port}/`);
  expect(p.state).toBe("not_answering");
  expect((await statusWithStandby(ready, async () => p)).says).toStartWith("Ready, standby not answering");
});

test("not ready: says is untouched", async () => {
  const draining: Status = { phase: "draining", working: 2, says: "Draining: 2" };
  expect((await statusWithStandby(draining, async () => ({ state: "unset", says: "x" }))).says).toBe("Draining: 2");
});

test("a redirect is not followed: it is not answering", async () => {
  const redir = Bun.serve({ port: 0, fetch: () => new Response("", { status: 302, headers: { location: `http://127.0.0.1:${standby.port}/` } }) });
  forgetStandby();
  const p = await probeStandby(`http://127.0.0.1:${redir.port}/`);
  redir.stop(true);
  expect(p.state).toBe("not_answering");
  expect(p.says).toContain("302");
});

test("a standby that never answers times out as not answering", async () => {
  const hang = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => undefined) });
  forgetStandby();
  const t = performance.now();
  const p = await probeStandby(`http://127.0.0.1:${hang.port}/`);
  hang.stop(true);
  expect(p.state).toBe("not_answering");
  expect(performance.now() - t).toBeLessThan(4000);
});

test("the body is read up to the cap and the stream cancelled", async () => {
  let cancelled = false;
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      sent += 16384;
      c.enqueue(new Uint8Array(16384).fill(97));
    },
    cancel() {
      cancelled = true;
    },
  });
  const text = await readCapped(new Response(body), 40000);
  expect(text.length).toBe(40000);
  expect(cancelled).toBe(true);
  expect(sent).toBeLessThan(100000);
});

test("the probe is cached for a few seconds", async () => {
  let hits = 0;
  const counted = Bun.serve({ port: 0, fetch: () => (hits++, new Response("no", { status: 200 })) });
  forgetStandby();
  const url = `http://127.0.0.1:${counted.port}/`;
  await probeStandby(url);
  await probeStandby(url);
  counted.stop(true);
  expect(hits).toBe(1);
});

test("said once: ready carries it in the lead, withStandby leaves other phases alone", () => {
  const s = withStandby(ready, { state: "answering", says: "Standby answering: x" });
  expect(s.says).toStartWith("Ready, standby answering");
  expect(s.standby.says).toBe("Standby answering: x");
});
