import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { renderCard } from "../src/web/og/card.ts";
import { cardKey, pngCache } from "../src/web/og/png-cache.ts";
import { useLoader } from "../src/web/og/raster.ts";

const PNG = [0x89, 0x50, 0x4e, 0x47];

describe("og png", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ogpng-"));
    app = createForge({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "alice-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const made = await createRepo(app, u.value, { name: "shown", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await createRepo(app, u.value, { name: "hidden", visibility: "private" });
  });

  afterEach(() => useLoader());

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a PNG of the card, rasterized once and served from disk after", async () => {
    const cold = await fetch(`${base}/og/repo/alice~shown.png`);
    expect(cold.status).toBe(200);
    expect(cold.headers.get("content-type")).toBe("image/png");
    expect(cold.headers.get("x-content-type-options")).toBe("nosniff");
    const bytes = new Uint8Array(await cold.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual(PNG);
    // 1200×630 in the IHDR.
    const dv = new DataView(bytes.buffer);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([1200, 630]);
    const files = await readdir(join(dataDir, "og-png"));
    expect(files).toHaveLength(1);
    const written = (await stat(join(dataDir, "og-png", files[0]!))).ino;

    const warm = new Uint8Array(await (await fetch(`${base}/og/repo/alice~shown.png`)).arrayBuffer());
    expect(warm).toEqual(bytes);
    expect(await readdir(join(dataDir, "og-png"))).toEqual(files);
    expect((await stat(join(dataDir, "og-png", files[0]!))).ino).toBe(written);

    const etag = cold.headers.get("etag")!;
    const again = await fetch(`${base}/og/repo/alice~shown.png`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  test("private and malformed refs are the same 404", async () => {
    expect((await fetch(`${base}/og/repo/alice~hidden.png`)).status).toBe(404);
    expect((await fetch(`${base}/og/repo/..%2F..~x.png`)).status).toBe(404);
  });

  test("a rasterizer that fails to load answers 503 and the forge still answers", async () => {
    useLoader(() => Promise.reject(new Error("no wasm here")));
    const res = await fetch(`${base}/og/repo/alice~shown.png`);
    // Cached from the first test: a warm card needs no rasterizer.
    expect(res.status).toBe(200);
    await rm(join(dataDir, "og-png"), { recursive: true, force: true });
    // A fresh forge-side cache is per app; drop the on-disk card and ask again.
    const fresh = await fetch(`${base}/og/repo/alice~shown.png`);
    expect(fresh.status).toBe(503);
    expect((await fresh.text()).length).toBeLessThan(100);
    expect((await fetch(`${base}/og/repo/alice~shown.svg`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBeLessThan(500);
  });

  test("the cache keeps at most its cap, least recently used out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ogcap-"));
    try {
      let renders = 0;
      const cache = pngCache({
        dir,
        cap: 2,
        svg: renderCard,
        raster: async () => () => (renders++, new Uint8Array([...PNG, renders])),
      });
      const card = (n: number) => ({ kind: "page" as const, title: `card ${n}` });
      await cache.get(card(1));
      await cache.get(card(2));
      await cache.get(card(1)); // 1 is now the freshest
      await cache.get(card(3)); // evicts 2
      const files = (await readdir(dir)).sort();
      expect(files).toEqual([cardKey(card(1)) + ".png", cardKey(card(3)) + ".png"].sort());
      expect(renders).toBe(3);
      await cache.get(card(1));
      expect(renders).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a render that throws answers 503, leaves no file, and a good rasterizer then serves", async () => {
    await rm(join(dataDir, "og-png"), { recursive: true, force: true });
    useLoader(async () => () => {
      throw new Error("render blew up");
    });
    const bad = await fetch(`${base}/og/repo/alice~shown.png`);
    expect(bad.status).toBe(503);
    expect(bad.headers.get("retry-after")).toBeTruthy();
    expect(await readdir(join(dataDir, "og-png")).catch(() => [])).toEqual([]);

    // The directory vanishing at runtime is survivable too.
    await rm(join(dataDir, "og-png"), { recursive: true, force: true });
    useLoader();
    const good = await fetch(`${base}/og/repo/alice~shown.png`);
    expect(good.status).toBe(200);
    expect([...new Uint8Array(await good.arrayBuffer()).slice(0, 4)]).toEqual(PNG);
    expect(await readdir(join(dataDir, "og-png"))).toHaveLength(1);
  });

  test("cold renders run one at a time and a long queue is refused", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ogq-"));
    try {
      let running = 0;
      let peak = 0;
      const cache = pngCache({
        dir,
        queue: 3,
        svg: renderCard,
        raster: async () => () => {
          peak = Math.max(peak, ++running);
          running--;
          return new Uint8Array(PNG);
        },
      });
      const card = (n: number) => ({ kind: "page" as const, title: `card ${n}` });
      const results = await Promise.allSettled([1, 2, 3, 4, 5].map((n) => cache.get(card(n))));
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "rejected"]);
      expect(peak).toBe(1);
      // Once drained, a refused card can be made.
      await cache.get(card(4));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a directory already over the cap is trimmed on first use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-ogtrim-"));
    try {
      const mk = (cap: number) =>
        pngCache({ dir, cap, svg: renderCard, raster: async () => () => new Uint8Array(PNG) });
      const card = (n: number) => ({ kind: "page" as const, title: `card ${n}` });
      const big = mk(10);
      for (const n of [1, 2, 3, 4]) await big.get(card(n));
      await mk(2).get(card(1));
      expect(await readdir(dir)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
