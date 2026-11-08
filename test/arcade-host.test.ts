/**
 * Launching a display: the display page offers Launch for the Arcade's
 * display, and the Arcade host (`arcade.<app domain>`) lists its carts,
 * carries a policy with no third-party origin, and plays only what the
 * display shows.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { importCart } from "../src/arcade/import.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { signCart } from "../src/display/launch.ts";
import { serve, type Servers } from "../src/http/server.ts";

const DOMAIN = "apps.test";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
const tagger = { name: "Jay Moran", email: "jay@example.test" };

describe("the Arcade host", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let sha = "";

  const arcade = (path: string, init: RequestInit = {}) =>
    fetch(`${servers.url}${path}`, { ...init, headers: { host: `arcade.${DOMAIN}`, ...(init.headers ?? {}) }, redirect: "manual" });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-arcade-host-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url }).start();
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    for (const name of ["karts", "arcade-display"]) {
      const r = await createRepo(app, alice, { name, visibility: "public" });
      if (!r.ok) throw new Error(String(r.error));
    }
    const repo = (await import("../src/core/repos.ts")).getRepo(app.db, "alice", "karts")!;
    const c = await commitToBranch(app, alice, repo, { message: "one", files: [{ path: "a.txt", content: "a" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    sha = c.value.commitOid;
    const imported = await importCart(dataDir, { repo: "alice/karts", label: "iter-1", sha, note: "n", cart: { name: "fiesta-kart", version: "1.0", page: "/", shelf: true }, html: new TextEncoder().encode("<p>fiesta</p>"), cover: PNG, art: PNG }, tagger);
    if (!imported.ok) throw new Error(JSON.stringify(imported.error));
    const display = (await import("../src/core/repos.ts")).getRepo(app.db, "alice", "arcade-display")!;
    const d = await commitToBranch(app, alice, display, {
      message: "display",
      files: [{ path: "display.json", content: JSON.stringify({ title: "arcade-builds", layout: "shelf", sources: ["alice/karts"], shelf: { producer: "jbox" } }) }],
    });
    if (!d.ok) throw new Error(JSON.stringify(d.error));
  });

  afterAll(async () => {
    app.close();
    await servers.stop?.();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the display page links Launch to the host", async () => {
    const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
    const res = await fetch(`${servers.url}/alice/arcade-display/display`, { headers: { cookie } });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain(`href="http://arcade.${DOMAIN}:${servers.port}/"`);
    expect(body).toContain("Launch");
  });

  test("the host page carries the floor headers and a policy with no third-party origin", async () => {
    const res = await arcade("/");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toMatch(/https?:\/\//);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const page = await res.text();
    expect(page).not.toContain("fonts.googleapis.com");
    expect(page).toContain("<noscript>");
    expect(page).toContain('id="prev"');
    expect(page).toContain("hint-touch");
  });

  test("the host lists the display's carts and serves their pages", async () => {
    const games = (await (await arcade("/games.json")).json()) as { name: string; builds: { file: string }[] }[];
    expect(games.map((g) => g.name)).toEqual(["fiesta-kart"]);
    const file = games[0]!.builds[0]!.file;
    const played = await arcade(`/${file}`);
    expect(played.status).toBe(200);
    expect(await played.text()).toBe("<p>fiesta</p>");
    expect(played.headers.get("content-security-policy")).toContain("frame-ancestors");
  });

  test("the host answers only reads, and nothing outside the display", async () => {
    expect((await arcade("/", { method: "POST" })).status).toBe(405);
    expect((await arcade("/carts/alice/karts/" + "0".repeat(40) + "/index.html")).status).toBe(404);
    expect((await arcade("/settings")).status).toBe(404);
  });

  test("a malformed escape in the path is a 404, not a 500", async () => {
    expect((await arcade("/%E0%A4%A")).status).toBe(404);
  });

  test("an unknown path is a 404", async () => {
    expect((await arcade("/nothing/here")).status).toBe(404);
  });

  describe("a grant (?g=)", () => {
    const path = "carts/alice/karts/" + "0".repeat(40) + "/index.html";
    test("a good grant reaches the lookup (still 404: no such pin), a bad one never does", async () => {
      const good = signCart(dataDir, path);
      expect((await arcade(`/${path}?g=${encodeURIComponent(good)}`)).status).toBe(404);
    });
    test("an expired grant is refused", async () => {
      const { verifyCart } = await import("../src/display/launch.ts");
      const old = signCart(dataDir, path, Date.now() - 2 * 60 * 60 * 1000);
      expect(verifyCart(dataDir, path, old)).toBe(false);
    });
    test("a grant for another path is refused", async () => {
      const { verifyCart } = await import("../src/display/launch.ts");
      expect(verifyCart(dataDir, path, signCart(dataDir, "carts/alice/karts/other.html"))).toBe(false);
      expect(verifyCart(dataDir, path, signCart(dataDir, path))).toBe(true);
    });
    test("a tampered or malformed grant is refused", async () => {
      const { verifyCart } = await import("../src/display/launch.ts");
      const good = signCart(dataDir, path);
      const flipped = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
      expect(verifyCart(dataDir, path, flipped)).toBe(false);
      expect(verifyCart(dataDir, path, "nodot")).toBe(false);
      expect(verifyCart(dataDir, path, "99999999999999." + good.split(".")[1])).toBe(false);
    });
  });
});
