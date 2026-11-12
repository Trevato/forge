/**
 * /system (#2151): fixed samples roll up into hours (mean, max, count),
 * old hours are dropped, and the page draws RSS and the heap for an admin
 * and is 403 for anyone else.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { HOUR_MS, memoryHours, recordMemory } from "../src/boards/memory.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { encodeRecent, RECENT_BYTES } from "../src/http/compress.ts";
import { cachesSection, pageCaches } from "../src/web/pages/system.ts";

const MiB = 1_048_576;
let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
const tok: Record<string, string> = {};
const get = (who: string | null) =>
  fetch(servers.url + "/system", { headers: who ? { authorization: `Bearer ${tok[who]}` } : {} });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-system-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  for (const [username, first] of [["alice", true], ["bob", false]] as const) {
    const r = await createUser(app.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(first ? { adminIfFirst: true } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    tok[username] = createToken(app.db, r.value.id, "t", "admin").token;
  }
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("hourly roll-up", () => {
  test("mean, max and count per hour from fixed samples", () => {
    const h0 = 1_000 * HOUR_MS;
    recordMemory(app.db, 100 * MiB, 10 * MiB, h0);
    recordMemory(app.db, 300 * MiB, 30 * MiB, h0 + 60_000);
    recordMemory(app.db, 200 * MiB, 20 * MiB, h0 + 120_000);
    recordMemory(app.db, 500 * MiB, 10 * MiB, h0 + HOUR_MS + 5);
    const hours = memoryHours(app.db, h0 + HOUR_MS + 10);
    expect(hours).toEqual([
      { at: h0, samples: 3, rssMean: 200 * MiB, rssMax: 300 * MiB, heapMean: 20 * MiB, heapMax: 30 * MiB },
      { at: h0 + HOUR_MS, samples: 1, rssMean: 500 * MiB, rssMax: 500 * MiB, heapMean: 10 * MiB, heapMax: 10 * MiB },
    ]);
  });

  test("a bad reading is ignored and hours past a week are dropped", () => {
    const now = 5_000 * HOUR_MS;
    recordMemory(app.db, Number.NaN, 1, now);
    recordMemory(app.db, -1, 1, now);
    recordMemory(app.db, 1, 1, now - 8 * 24 * HOUR_MS);
    recordMemory(app.db, MiB, MiB, now);
    expect(memoryHours(app.db, now, 24 * 30).map((h) => h.at)).toEqual([now]);
  });

  test("only the last 24 hours are returned", () => {
    const now = 9_000 * HOUR_MS;
    recordMemory(app.db, MiB, MiB, now - 30 * HOUR_MS);
    recordMemory(app.db, MiB, MiB, now);
    expect(memoryHours(app.db, now).map((h) => h.at)).toEqual([now]);
  });
});

describe("GET /system", () => {
  test("an admin sees both series, server-rendered", async () => {
    recordMemory(app.db, 120 * MiB, 40 * MiB, Date.now());
    const res = await get("alice");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("RSS (MiB, hourly mean)");
    expect(body).toContain("JS heap (MiB, hourly mean)");
    expect(body.match(/<svg/g)?.length).toBeGreaterThanOrEqual(2);
    // Both series are drawn in chartBox()'s frame (#4282).
    expect(body.match(/<div class="chart-box"><svg [^>]*class="chart"/g)?.length).toBe(2);
    expect(body).toContain("120.0 MiB");
    expect(body).toContain("40.0 MiB");
  });

  test("the chart pair is drawn with the base .plots grid, not .sys-pair", async () => {
    recordMemory(app.db, 120 * MiB, 40 * MiB, Date.now());
    const body = await (await get("alice")).text();
    expect(body).not.toContain("sys-pair");
    expect(body).toContain('<div class="plots">');
    expect(body).toContain('<h3 class="small">RSS (MiB, hourly mean)</h3>');
    expect(body).toContain('<h3 class="small">JS heap (MiB, hourly mean)</h3>');
    expect(body).toContain('aria-label="Forge memory by hour"');
    expect(body).toContain("Heap max");
  });

  test("a non-admin gets 404 and an anonymous visitor is sent to sign in", async () => {
    expect((await get("bob")).status).toBe(404);
    const anon = await fetch(servers.url + "/system", { redirect: "manual" });
    expect(anon.status).toBe(303);
  });
});

describe("code page caches (#9514)", () => {
  test("each cache shows its entries, bytes beside its cap, and hits and misses", () => {
    const body = new TextEncoder().encode("<p>" + "x".repeat(4096) + "</p>") as Uint8Array<ArrayBuffer>;
    const before = pageCaches().find((r) => r.name === "encoded bodies")!;
    encodeRecent(body, "br");
    encodeRecent(body, "br");
    const after = pageCaches().find((r) => r.name === "encoded bodies")!;
    expect(after.capBytes).toBe(RECENT_BYTES);
    expect(after.hits).toBe(before.hits + 1);
    expect(after.bytes).toBeGreaterThan(before.bytes);
    expect(pageCaches().map((r) => r.name)).toEqual(["kept pages", "encoded bodies", "page columns", "folders and refs"]);
    // 128 MB together at most is what the pull says: the caps add up to it.
    const caps = pageCaches().filter((r) => r.name !== "page columns").reduce((n, r) => n + r.capBytes, 0);
    expect(caps).toBe(128 * MiB);
    const html = String(cachesSection([{ name: "kept pages", holds: "<b>", capBytes: 64 * MiB, entries: 3, bytes: 2 * MiB, hits: 3, misses: 1 }]));
    expect(html).toContain('data-cache="kept pages"');
    expect(html).toContain("2.0 MiB");
    expect(html).toContain("64.0 MiB");
    expect(html).toContain("75.0%");
  });

  test("the owner's /system shows them", async () => {
    const body = await (await get("alice")).text();
    expect(body).toContain("<h2>Code page caches, since start</h2>");
    for (const name of ["kept pages", "encoded bodies", "page columns", "folders and refs"]) expect(body).toContain(`data-cache="${name}"`);
  });
});

describe("reaching /system", () => {
  test("the account menu links it for an admin only", async () => {
    const withCookie = async (who: string) =>
      (await (await fetch(servers.url + "/", { headers: { authorization: `Bearer ${tok[who]}` } })).text());
    expect(await withCookie("alice")).toContain('href="/system"');
    expect(await withCookie("bob")).not.toContain('href="/system"');
  });

  test("a refused visitor gets a page, not bare text", async () => {
    const res = await get("bob");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("<h1>");
  });
});
