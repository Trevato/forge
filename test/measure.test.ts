import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { beaconJs } from "../src/web/beacon.ts";
import { beaconAsset } from "../src/web/asset.ts";
import { DAY_MAX, parseReport, recordVital } from "../src/web/measure.ts";

let dir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "measure-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  base = `http://127.0.0.1:${servers.port}`;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const good = { path: "/", ttfb: 40, load: 300, lcp: 250, inp: 80, cls: 0.02 };
const send = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/_measure`, {
    method: "POST",
    headers: { origin: base, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const rows = () => app.db.query("SELECT * FROM page_vital").all() as Record<string, unknown>[];
const count = () => rows().length;

describe("the page-view beacon", () => {
  test("the script is under 2048 bytes, immutable, and linked from a page", async () => {
    expect(new TextEncoder().encode(beaconJs).length).toBeLessThan(2048);
    const asset = beaconAsset();
    const script = await fetch(base + asset.path);
    expect(script.status).toBe(200);
    expect(script.headers.get("cache-control")).toContain("immutable");
    expect(await script.text()).toBe(beaconJs);
    const home = await fetch(base + "/");
    expect(await home.text()).toContain(asset.path);
    expect(home.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(home.headers.get("content-security-policy")).not.toContain("unsafe");
  });

  test("the path is read once, at start, not when the page hides", () => {
    expect(beaconJs.match(/location\.pathname/g)).toHaveLength(1);
    expect(beaconJs).toContain("a=location.pathname");
  });

  test("a valid report is stored by route pattern, with no address or agent", async () => {
    const before = count();
    const res = await send({ ...good, path: "/someone/thing" }, { "user-agent": "Mozilla/5.0 Secret" });
    expect(res.status).toBe(204);
    expect(count()).toBe(before + 1);
    const row = rows().at(-1)!;
    expect(row["route"]).toBe("/:owner/:name");
    expect(row["lcp"]).toBe(250);
    expect(row["cls"]).toBe(0.02);
    expect(String(row["visitor"])).toMatch(/^[0-9a-f]{32}$/);
    const text = JSON.stringify(rows());
    expect(text).not.toContain("Secret");
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain("someone");
  });

  test("a cross-origin, originless, oversized or malformed report is refused", async () => {
    const before = count();
    expect((await send(good, { origin: "https://evil.example" })).status).toBe(403);
    const bare = await fetch(`${base}/_measure`, { method: "POST", body: JSON.stringify(good) });
    expect(bare.status).toBe(403);
    expect((await send("x".repeat(5000))).status).toBe(413);
    expect((await send("{nope")).status).toBe(400);
    expect((await send({ ...good, cls: "1" })).status).toBe(400);
    expect((await send({ ...good, lcp: 1e12 })).status).toBe(400);
    expect((await send({ ...good, lcp: -1 })).status).toBe(400);
    expect((await send({ ...good, extra: 1 })).status).toBe(400);
    expect((await send({ ...good, path: "https://evil.example/" })).status).toBe(400);
    expect((await send({ ...good, path: "/a\nb" })).status).toBe(400);
    expect((await send([1])).status).toBe(400);
    expect((await send({ ...good, path: "/_nothing/at/all/here/x/y/z" })).status).toBe(400);
    expect(count()).toBe(before);
  });

  test("Do-Not-Track and the opt-out cookie store nothing", async () => {
    const before = count();
    expect((await send(good, { dnt: "1" })).status).toBe(204);
    expect((await send(good, { cookie: "a=b; forge_measure=off" })).status).toBe(204);
    expect(count()).toBe(before);
  });

  test("a client past its rate is told to wait", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await send(good)).status);
    expect(statuses).toContain(429);
  });
});

describe("the report and the visitor hash", () => {
  test("0 means not measured, and absent times are null", () => {
    expect(parseReport('{"path":"/","cls":0,"lcp":0}')).toEqual({
      path: "/", ttfb: null, load: null, lcp: null, inp: null, cls: 0,
    });
  });

  test("the salt rotates daily: same browser, same day, same hash; next day, another", () => {
    const report = parseReport(JSON.stringify(good));
    if (report === "malformed") throw new Error("bad fixture");
    const day = Date.UTC(2026, 0, 5, 10);
    const visitor = () => (rows().at(-1) as { visitor: string }).visitor;
    app.db.run("DELETE FROM page_vital");
    recordVital(app.db, report, "/", "1.2.3.4", "ua", day);
    const first = visitor();
    recordVital(app.db, report, "/", "1.2.3.4", "ua", day + 1000);
    expect(visitor()).toBe(first);
    recordVital(app.db, report, "/", "1.2.3.4", "ua", day + 86_400_000);
    expect(visitor()).not.toBe(first);
    expect((app.db.query("SELECT COUNT(*) AS n FROM vital_salt").get() as { n: number }).n).toBe(1);
  });

  test("a full day drops reports instead of growing the table", () => {
    const report = parseReport(JSON.stringify(good));
    if (report === "malformed") throw new Error("bad fixture");
    const at = Date.UTC(2026, 5, 1, 12);
    app.db.run("DELETE FROM page_vital");
    for (let i = 0; i < 5; i++) expect(recordVital(app.db, report, "/", "c", "u", at, 5)).toBe(true);
    expect(recordVital(app.db, report, "/", "c", "u", at, 5)).toBe(false);
    expect(count()).toBe(5);
    // The next day has its own room.
    expect(recordVital(app.db, report, "/", "c", "u", at + 86_400_000, 5)).toBe(true);
    expect(DAY_MAX).toBeLessThanOrEqual(50_000);
  });
});
