/**
 * A pin's cart through its doors: the API names it and starts its capture,
 * the builds page links a captured cart, and the cart plays sandboxed to the
 * repository's readers only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { importCapture } from "../src/arcade/carts.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);

describe("a pin's cart", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  const tokens: Record<string, string> = {};
  // Each repository's own pinned commit: captures are keyed by oid, and two
  // commits only share one when they land in the same clock second.
  const oids: Record<string, string> = {};

  const api = (path: string, who?: string, init: RequestInit = {}) =>
    fetch(`${base}/api/v1/repos/alice/${path}`, {
      ...init,
      headers: { ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}), "content-type": "application/json" },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cart-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    for (const name of ["alice", "bob"]) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
      if (!made.ok) throw new Error(made.error);
      tokens[name] = createToken(app.db, getUserByName(app.db, name)!.id, "t", "rw").token;
    }
    const alice = getUserByName(app.db, "alice")!;
    for (const [name, visibility] of [["karts", "public"], ["secret", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      const c = await commitToBranch(app, alice, made.value, { message: "one", files: [{ path: "a.txt", content: "a\n" }] });
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      oids[name] = c.value.commitOid;
      const pinned = await pinBuild(app, alice, made.value, { label: "v1", oid: c.value.commitOid });
      if (!pinned.ok) throw new Error(pinned.error);
    }
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a pin with no cart says so", async () => {
    const res = await api("karts/builds/v1/cart");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ label: "v1", demo: null, capture: { state: "none" }, play_url: null });
    expect((await api("karts/builds/nope/cart")).status).toBe(404);
  });

  test("a writer names the cart and its capture starts; a reader, a stranger and a bad name are refused", async () => {
    const send = (who: string | undefined, b: object) => api("karts/builds/v1/cart", who, { method: "POST", body: JSON.stringify(b) });
    const cart = { name: "fiesta-kart", version: "1", page: "/", showcase: true };
    expect((await send(undefined, cart)).status).toBe(401);
    expect((await send("bob", cart)).status).toBe(403);
    expect((await send("alice", { ...cart, name: "two\nlines" })).status).toBe(422);
    expect((await send("alice", { ...cart, page: "/../x" })).status).toBe(422);
    const res = await send("alice", cart);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ demo: { name: "fiesta-kart", version: "1", launch: "file", page: "/", showcase: true } });
    // karts is no app, so there is no build to capture from: the state says why.
    await Bun.sleep(50);
    expect(await (await api("karts/builds/v1/cart")).json()).toMatchObject({ capture: { state: "failed", error: "not_an_app" } });
  });

  test("a captured cart plays sandboxed, with its picture, and the builds page links it", async () => {
    importCapture(dataDir, { ownerName: "alice", name: "karts" }, oids.karts!, "/", new TextEncoder().encode("<p>kart</p>"), PNG);
    expect(await (await api("karts/builds/v1/cart")).json()).toMatchObject({
      capture: { state: "done" },
      play_url: "/alice/karts/builds/v1/cart",
      art_url: "/alice/karts/builds/v1/cart.png",
    });
    const played = await fetch(`${base}/alice/karts/builds/v1/cart`);
    expect(played.status).toBe(200);
    expect(await played.text()).toBe("<p>kart</p>");
    const policy = played.headers.get("content-security-policy") ?? "";
    expect(policy).toStartWith("sandbox allow-scripts");
    expect(policy).not.toContain("allow-same-origin");
    expect(played.headers.get("x-content-type-options")).toBe("nosniff");
    const art = await fetch(`${base}/alice/karts/builds/v1/cart.png`);
    expect(art.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await art.arrayBuffer())).toEqual(PNG);
    const page = await (await fetch(`${base}/alice/karts/builds`)).text();
    expect(page).toContain('href="/alice/karts/builds/v1/cart"');
    expect(page).toContain("fiesta-kart");
  });

  test("a private repository's cart is not found by a stranger", async () => {
    const send = await api("secret/builds/v1/cart", "alice", { method: "POST", body: JSON.stringify({ name: "hush", version: "1", page: "/", showcase: false }) });
    expect(send.status).toBe(202);
    importCapture(dataDir, { ownerName: "alice", name: "secret" }, oids.secret!, "/", new TextEncoder().encode("<p>hush</p>"));
    expect((await api("secret/builds/v1/cart")).status).toBe(404);
    expect((await fetch(`${base}/alice/secret/builds/v1/cart`)).status).toBe(404);
    expect((await api("secret/builds/v1/cart", "alice")).status).toBe(200);
  });
});
