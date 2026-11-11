// Uncaught script errors the beacon reports (#11447): counted, bounded, same-origin.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { scriptErrorCounts } from "../src/http/script_errors.ts";
import { beaconJs } from "../src/web/beacon.ts";

let dir = "";
let app: App;
let servers: Servers;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "script-errors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

let ip = 0;
const send = (body: string, headers: Record<string, string> = {}) =>
  fetch(`${servers.url}/_script-error`, {
    method: "POST",
    headers: { origin: servers.url, "x-forwarded-for": `10.9.0.${++ip}`, ...headers },
    body,
  });
const rows = () => app.db.query<{ n: number }, []>("SELECT COALESCE(SUM(n),0) AS n FROM script_error").get()!.n;
const good = { page: "/", src: "/a.js", line: 3, msg: "x is not defined" };

test("a well-formed report is counted once per hour key, with the floor headers", async () => {
  const a = await send(JSON.stringify(good));
  expect(a.status).toBe(204);
  expect(a.headers.get("x-content-type-options")).toBe("nosniff");
  await send(JSON.stringify(good));
  const c = scriptErrorCounts(app.db);
  expect(c).toHaveLength(1);
  expect(c[0]).toMatchObject({ page: "/", where: "/a.js:3", message: "x is not defined", n: 2 });
});

test("only the first line, cut to 120 characters, is kept", async () => {
  await send(JSON.stringify({ ...good, line: 4, msg: `${"y".repeat(300)}\nsecret second line` }));
  const c = scriptErrorCounts(app.db).find((r) => r.where === "/a.js:4")!;
  expect(c.message).toBe("y".repeat(120));
});

test("oversized, wrong-type, cross-origin and malformed reports store nothing", async () => {
  const before = rows();
  expect((await send("x".repeat(3000))).status).toBe(413);
  expect((await send(JSON.stringify({ ...good, line: "3" }))).status).toBe(400);
  expect((await send(JSON.stringify({ ...good, src: "https://evil.example/a.js" }))).status).toBe(400);
  expect((await send(JSON.stringify({ ...good, src: "/a.js?q=1" }))).status).toBe(400);
  expect((await send(JSON.stringify({ ...good, extra: 1 }))).status).toBe(400);
  expect((await send(JSON.stringify({ ...good, page: "/no/such/route/at/all" }))).status).toBe(400);
  expect((await send(JSON.stringify(good), { origin: "https://evil.example" })).status).toBe(403);
  expect((await send(JSON.stringify(good), { dnt: "1" })).status).toBe(204);
  expect(rows()).toBe(before);
});

test("the beacon sends at most 5 per page view, same-origin scripts only, and stays under 2 KB", () => {
  expect(beaconJs.length).toBeLessThan(2048);
  const sent: string[] = [];
  const handlers: Record<string, (e: unknown) => void> = {};
  const w = { addEventListener: (t: string, f: (e: unknown) => void) => (handlers[t] = f), PerformanceObserver: class { observe() {} } };
  const d = { cookie: "", referrer: "", addEventListener() {} };
  const n = { doNotTrack: "0", sendBeacon: (_u: string, b: string) => sent.push(b) };
  const g = globalThis as any;
  const registered = (nav: object, doc: object) => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    new Function("navigator", "document", "window", beaconJs)(nav, doc, w);
    return Object.keys(handlers);
  };
  const saved = { location: g.location, performance: g.performance };
  g.location = { pathname: "/claim", origin: "https://f.test", href: "https://f.test/claim", search: "", hostname: "f.test" };
  try {
    expect(registered({ ...n, doNotTrack: "1" }, d)).toEqual([]);
    expect(registered(n, { ...d, cookie: "a=1; forge_measure=off" })).toEqual([]);
    expect(sent).toHaveLength(0);
    expect(registered(n, d)).toContain("error");
    for (let i = 0; i < 9; i++) handlers.error!({ filename: "https://f.test/a.js?v=1", lineno: i, message: "boom" });
    expect(sent).toHaveLength(5);
    expect(JSON.parse(sent[0]!)).toEqual({ page: "/claim", src: "/a.js", line: 0, msg: "boom" });
    const before = sent.length;
    handlers.error!({ filename: "https://other.test/a.js", lineno: 1, message: "Script error." });
    expect(sent).toHaveLength(before);
  } finally {
    g.location = saved.location;
  }
});
