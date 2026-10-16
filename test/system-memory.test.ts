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
    expect(body).toContain("120.0 MiB");
    expect(body).toContain("40.0 MiB");
  });

  test("a non-admin gets 404 and an anonymous visitor is sent to sign in", async () => {
    expect((await get("bob")).status).toBe(404);
    const anon = await fetch(servers.url + "/system", { redirect: "manual" });
    expect(anon.status).toBe(303);
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
