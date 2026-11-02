import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { sharedCache } from "../src/http/edge_cache.ts";
import { commitToBranch, createLabel, createRepo } from "../src/actions/repos.ts";
import { NO_PREFETCH_PATHS, NO_PREFETCH_QUERY, pageScriptAsset, pageScriptDir, pageScriptNamed, speculationAsset } from "../src/web/asset.ts";
import { rawResponse } from "../src/web/pages/repo.ts";
import { getUserById } from "../src/core/users.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

// The budgets of docs/web.md, counted in bytes of the raw response body.
const BUDGET = { html: 40_000, inlineScripts: 0, inlineSvg: 0 };

describe("web budgets (docs/web.md)", () => {
  quietLogs();
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let base = "";
  let cookie = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-budget-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, { username: "ada", email: "ada@forge.local", password: "analytical-engine" });
    const ada = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'ada'").get()!;
    const user = getUserById(app.db, ada.id)!;
    for (const [name, visibility] of [["open", "public"], ["closed", "private"]] as const) {
      const made = await createRepo(app, user, { name, visibility });
      if (!made.ok) throw new Error("repo failed");
      if (name === "open") {
        await commitToBranch(app, user, made.value, {
          message: "files",
          files: [{ path: "x.js", content: "alert(document.cookie)\n" }, { path: "y.svg", content: "<svg/>" }],
        });
        createLabel(app, user, made.value, "bug", "d73a4a");
      }
    }
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const path of ["/", "/explore"]) {
    test(`${path}: small, no inline script, no inline drawing`, async () => {
      const res = await fetch(base + path);
      const text = await res.text();
      expect(new TextEncoder().encode(text).length).toBeLessThan(BUDGET.html);
      expect(/<script(?![^>]*\s(src=|type="application\/json"))/.test(text)).toBe(BUDGET.inlineScripts > 0);
      expect(text.includes("<symbol")).toBe(BUDGET.inlineSvg > 0);
      expect(text).toContain("/assets/i-");
    });
  }

  test("the policy carries no nonce, and the page names its assets as preloads", async () => {
    const res = await fetch(base + "/");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("nonce");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toMatch(/style-src 'self' 'sha256-/);
    expect(res.headers.get("link")).toContain("rel=preload");
    expect(res.headers.get("speculation-rules")).toMatch(/^"\/assets\/speculation-/);
  });

  test("the sprite and speculation rules are immutable files", async () => {
    const text = await (await fetch(base + "/")).text();
    const sprite = /\/assets\/i-[0-9a-f]+\.svg/.exec(text)![0];
    const res = await fetch(base + sprite);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toContain('<symbol id="i-');
    const rules = await fetch(base + (/\/assets\/speculation-[0-9a-f]+\.json/.exec(
      (await fetch(base + "/")).headers.get("speculation-rules") ?? "")![0]));
    expect(rules.headers.get("content-type")).toContain("speculationrules");
  });

  test("a signed-out public page is edge-cacheable and revalidates with a 304", async () => {
    const first = await fetch(base + "/");
    expect(first.headers.get("cache-control")).toMatch(/^public, max-age=0, s-maxage=\d+, stale-while-revalidate=\d+$/);
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await fetch(base + "/", { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
  });

  test("a signed-in page is never edge-cached, with or without a cookie header", async () => {
    for (const path of ["/", "/explore"]) {
      const res = await fetch(base + path, { headers: { cookie } });
      const cc = res.headers.get("cache-control") ?? "";
      expect(cc).not.toContain("public");
      expect(cc).not.toContain("s-maxage");
      expect(res.headers.get("etag")).toBeNull();
    }
    const bearer = new Request("http://x/", { headers: { authorization: "Bearer t" } });
    expect(sharedCache(bearer, "/", () => false)).toBe("no-cache");
    expect(sharedCache(new Request("http://x/", { headers: { "x-plat-user": "u" } }), "/", () => false)).toBe("no-cache");
    expect(sharedCache(new Request("http://x/"), "/ada/engine/issues", () => false)).toBe("no-cache");
  });

  test("back/forward cache: no no-store, no unload handlers", async () => {
    for (const init of [{}, { headers: { cookie } }]) {
      const res = await fetch(base + "/", init);
      const text = await res.text();
      expect(res.headers.get("cache-control")).not.toContain("no-store");
      expect(text).not.toMatch(/\bunload\b/);
      for (const src of text.match(/\/assets\/[\w.-]+\.js/g) ?? []) {
        const js = await (await fetch(base + src)).text();
        expect(js).not.toMatch(/["']unload["']|onunload|beforeunload/);
      }
    }
  });

  test("only home, explore and an existing public repo's front page are shared", async () => {
    // A two-segment path that is not a repository is never shared, however it renders.
    for (const path of ["/apps/new", "/settings/tokens", "/-/confirm", "/ada/nope"]) {
      const res = await fetch(base + path, { redirect: "manual" });
      expect(res.headers.get("cache-control") ?? "no-cache").not.toContain("public");
      expect(res.headers.get("cache-control") ?? "no-cache").not.toContain("s-maxage");
    }
    const isPublic = (o: string, n: string): boolean => `${o}/${n}` === "ada/open";
    expect(sharedCache(new Request("http://x/"), "/apps/new", isPublic)).toBe("no-cache");
    expect(sharedCache(new Request("http://x/"), "/ada/closed", isPublic)).toBe("no-cache");
    expect(sharedCache(new Request("http://x/"), "/ada/open", isPublic)).toContain("s-maxage");
    // The live pages agree: the public repo is shared, the private one is not.
    const open = await fetch(base + "/ada/open");
    expect(open.status).toBe(200);
    expect(open.headers.get("cache-control")).toContain("s-maxage");
    const closed = await fetch(base + "/ada/closed");
    expect(closed.headers.get("cache-control") ?? "no-cache").not.toContain("public");
  });

  test("a shared copy varies on identity, so a signed-in visitor misses it", async () => {
    for (const path of ["/", "/explore", "/ada/open"]) {
      const vary = (await fetch(base + path)).headers.get("vary") ?? "";
      for (const h of ["Cookie", "Authorization", "X-Plat-User", "X-Plat-Edge-Token"]) expect(vary).toContain(h);
    }
  });

  test("no user-controlled route is a script: raw files are text/plain or octet-stream under nosniff", async () => {
    const res = await fetch(base + "/ada/open/raw/main/x.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toContain("sandbox");
    const svg = await fetch(base + "/ada/open/raw/main/y.svg");
    expect(svg.headers.get("content-type")).not.toMatch(/javascript|ecmascript|html|svg/);
    const bin = rawResponse({ kind: "binary", size: 3, head: new Uint8Array(3) } as never);
    expect(bin.headers.get("content-type")).toBe("application/octet-stream");
    // The only script-typed responses under /assets/ are the trusted, static files the forge renders.
    expect((await fetch(base + "/assets/page-0000000000000000.js")).status).toBe(404);
  });

  test("speculation rules exclude every GET with a side effect or a token", async () => {
    const rules = JSON.parse(speculationAsset().code);
    const where = rules.prefetch[0].where.and;
    expect(rules.prefetch[0].eagerness).toBe("moderate");
    const glob = (g: string): RegExp =>
      new RegExp("^" + g.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    const excluded = (path: string, search = ""): boolean =>
      (where[1].not.href_matches as string[]).some((g) => glob(g).test(path)) ||
      (where[2].not.href_matches as { search: string }[]).some((m) => glob(m.search).test(search));
    for (const p of [
      "/logout", "/signout", "/sign-out", "/signin/parent/callback", "/login", "/-/confirm", "/claim",
      "/first-admin", "/verify", "/go/abc", "/settings/tokens", "/apps/open", "/ada/open/app/prod/open",
      "/ada/open/raw/main/x.js", "/api/v1/x", "/assets/a.css", "/mcp", "/ada/-/teams/t",
    ])
      expect(excluded(p), p).toBe(true);
    for (const [p, q] of [["/", "?token=abc"], ["/ada/open", "?code=1"], ["/x/y", "?a=1&key=z"], ["/explore", "?state=s"]])
      expect(excluded(p!, q), p! + q!).toBe(true);
    for (const p of ["/", "/explore", "/ada/open", "/ada/open/issues"]) expect(excluded(p), p).toBe(false);
    expect(NO_PREFETCH_PATHS.length).toBeGreaterThan(10);
    expect(NO_PREFETCH_QUERY.length).toBeGreaterThan(5);
  });

  test("a page script is served by name for as long as the process lives, however many others render", () => {
    const first = pageScriptAsset("/* first */ 1");
    for (let i = 0; i < 700; i++) pageScriptAsset(`/* filler ${i} */ ${i}`);
    expect(pageScriptNamed(first.name)).toBe(first);
    expect(pageScriptNamed("page-nothing")).toBeUndefined();
  });

  test("a page script rendered before a restart is still served by a process that never rendered it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "page-scripts-"));
    try {
      const before = pageScriptAsset("/* before the restart */ 2", dir);
      // A fresh copy of the module is a restarted process: its maps are empty.
      const fresh = (await import(`../src/web/asset.ts?restart=${Date.now()}`)) as typeof import("../src/web/asset.ts");
      expect(fresh.pageScriptNamed(before.name)).toBeUndefined();
      const served = fresh.pageScriptNamed(before.name, dir);
      expect(served?.code).toBe(before.code);
      expect(served?.etag).toBe(before.etag);
      // A body that does not hash to its name, or a name that is not a page script's, is never read.
      writeFileSync(join(fresh.pageScriptDir(dir), "page-0000000000000000.js"), "alert(1)");
      expect(fresh.pageScriptNamed("page-0000000000000000", dir)).toBeUndefined();
      expect(fresh.pageScriptNamed("../../etc/passwd", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a rendered page keeps its script under the data dir, and the forge serves it by name", async () => {
    const page = await (await fetch(base + "/ada/open", { headers: { cookie } })).text();
    const name = page.match(/\/assets\/(page-[0-9a-f]{16})\.js/)?.[1];
    expect(name).toBeDefined();
    const files = readdirSync(pageScriptDir(dataDir));
    expect(files).toContain(`${name}.js`);
    const res = await fetch(`${base}/assets/${name}.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  test("the style hash in the policy matches the inline <style> on a page with its own styleCss", async () => {
    const res = await fetch(base + "/ada/open/settings/labels", { headers: { cookie } });
    expect(res.status).toBe(200);
    const text = await res.text();
    const styles = [...text.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    expect(styles.length).toBe(2);
    expect(styles[1]).toContain(".lc-d73a4a");
    const csp = res.headers.get("content-security-policy") ?? "";
    for (const css of styles) {
      const hash = new Bun.CryptoHasher("sha256").update(css).digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
  });
});
