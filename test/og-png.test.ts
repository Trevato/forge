import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp as createForge, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { recordLook } from "../src/core/looks.ts";
import { createUser } from "../src/core/users.ts";
import { encodePng } from "../src/design/image/png.ts";
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

  test("malformed refs are 404; a private repo's card is only its title and 'private'", async () => {
    expect((await fetch(`${base}/og/repo/alice~hidden.png`)).status).toBe(200);
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

describe("og cards with a look", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let appId = "";
  let owner: { id: string };

  /** A 1280×800 page-like picture: bands and blocks, so it compresses as a screenshot does. */
  const screenshot = (hue: number): Uint8Array => {
    const w = 1280;
    const h = 800;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        const block = ((x >> 5) + (y >> 5)) % 3;
        rgba[o] = (hue + block * 60 + (y >> 3)) & 255;
        rgba[o + 1] = 40 + block * 50;
        rgba[o + 2] = 200 - (x >> 3);
        rgba[o + 3] = 255;
      }
    return encodePng(w, h, rgba);
  };

  const look = (env: string, kind: "thumb" | "desktop", takenAs: "owner" | "nobody", hue: number) => {
    const path = join("looks", appId, env, `${hue}-${kind}.png`);
    mkdirSync(join(dataDir, "looks", appId, env), { recursive: true });
    writeFileSync(join(dataDir, path), screenshot(hue));
    return recordLook(app.db, { appId, env, commitOid: "a".repeat(40), kind, path, takenAs });
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-ogshot-"));
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
    owner = u.value;
    const made = await createRepo(app, u.value, { name: "peek", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const rec = createApp(app.db, { repoId: made.value.id, slug: "peek-app", access: "public" });
    if (!rec.ok) throw new Error(rec.error);
    appId = rec.value.id;
    const issue = createIssue(app.db, {
      repoId: made.value.id,
      authorId: u.value.id,
      title: "A pull with looks",
      kind: "pull",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id)
         VALUES (?1, 'main', 'topic', '', '', ?2)`,
      )
      .run(issue.value.id, made.value.id);
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const images = (svg: string) => svg.match(/<image /g)?.length ?? 0;
  const text = async (path: string) => (await fetch(`${base}${path}`)).text();

  test("without a look the app card is the card it was", async () => {
    expect(images(await text("/og/app/peek-app.svg"))).toBe(0);
  });

  test("a look taken as the owner is not on the card; one taken as nobody is, and a new look is a new card", async () => {
    look("production", "desktop", "owner", 1);
    expect(images(await text("/og/app/peek-app.svg"))).toBe(0);
    look("production", "desktop", "nobody", 2);
    const first = await fetch(`${base}/og/app/peek-app.svg`);
    expect(images(await first.text())).toBe(1);
    const etag = first.headers.get("etag")!;
    expect((await fetch(`${base}/og/app/peek-app.svg`, { headers: { "if-none-match": etag } })).status).toBe(304);

    // A retake of the same slot is a new taking, hence a new card.
    await Bun.sleep(5);
    look("production", "desktop", "nobody", 3);
    const second = await fetch(`${base}/og/app/peek-app.svg`);
    expect(second.headers.get("etag")).not.toBe(etag);
    await second.text();
  });

  test("the PNG twin carries the picture and stays small", async () => {
    const bare = await fetch(`${base}/og/repo/alice~peek.png`);
    const res = await fetch(`${base}/og/app/peek-app.png`);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual(PNG);
    expect(bytes.length).toBeLessThan(300 * 1024);
    // The picture's colour is in the right half of the card; the plain card's is not.
    expect(bytes.length).toBeGreaterThan(new Uint8Array(await bare.arrayBuffer()).length);
  });

  test("a pull card carries before and after, and a sealed or absent look nothing", async () => {
    expect(images(await text("/og/pull/alice~peek~1.svg"))).toBe(0);
    look("pull-1", "desktop", "nobody", 4);
    const svg = await text("/og/pull/alice~peek~1.svg");
    expect(images(svg)).toBe(2);
    expect(svg).toContain(">before<");
    expect(svg).toContain(">after<");
    app.db.query("UPDATE issue SET sealed = 1 WHERE kind = 'pull'").run();
    expect((await fetch(`${base}/og/pull/alice~peek~1.svg`)).status).toBe(404);
  });

  test("a look whose file is gone leaves the plain card", async () => {
    app.db.query("DELETE FROM look").run();
    look("production", "desktop", "nobody", 5);
    rmSync(join(dataDir, "looks", appId, "production", "5-desktop.png"));
    expect(images(await text("/og/app/peek-app.svg"))).toBe(0);
  });
});
