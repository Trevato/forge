/**
 * The well-known files every forge serves by default, from its own facts:
 * a security contact, a sitemap of what is public and nothing that is not,
 * an installable manifest with real icons, and the metadata a link needs
 * to unfurl.
 */
import { MAX_RELEASES, parseReleases } from "../src/core/parent_releases.ts";
import { setTagged, shippedReleases } from "../src/release/shipped.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { promote } from "./helpers/members.ts";
import { suspendAccount, unsuspendAccount } from "../src/actions/accounts.ts";
import { createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { decodePng, pngHeader } from "../src/design/image/png.ts";
import { markPng } from "../src/design/mark.ts";
import { createUser, type User } from "../src/core/users.ts";
import { forgetListings, listingBuilds } from "../src/core/listings.ts";
import { createOrg, retireOrg } from "../src/core/orgs.ts";
import { getRepo, moveArchived } from "../src/core/repos.ts";
import { SITE_LINE } from "../src/web/site_line.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("what the open web expects", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let alice: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-standards-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const pub = await createRepo(app, alice, {
      name: "open",
      visibility: "public",
    });
    if (!pub.ok) throw new Error(String(pub.error));
    const priv = await createRepo(app, alice, {
      name: "closed",
      visibility: "private",
    });
    if (!priv.ok) throw new Error(String(priv.error));
    // Password hashing and two repo creations are the setup's cost: a loaded
    // check machine gets the same generous bound as the tests (#6025).
  }, 60_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("security.txt has a fixed expiry and never publishes an address by default", async () => {
    const res = await fetch(`${base}/.well-known/security.txt`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    // The first account's page, which is already public — never its email.
    expect(body).toContain(`Contact: ${base}/alice`);
    expect(body).not.toContain("alice@forge.local");
    expect(body).not.toContain("mailto:");
    expect(body).toMatch(/Expires: \d{4}-01-01T00:00:00Z/);
    expect(body).toContain(`Canonical: ${base}/.well-known/security.txt`);
    // An operator who wants an address published writes it down.
    process.env["FORGE_SECURITY_CONTACT"] = "mailto:security@example.org";
    try {
      const set = await fetch(`${base}/.well-known/security.txt`).then((r) => r.text());
      expect(set).toContain("Contact: mailto:security@example.org");
    } finally {
      delete process.env["FORGE_SECURITY_CONTACT"];
    }
  });

  test("security.txt's contact is the sealed form of the forge's public repository", async () => {
    app.config.forgeRepo = "alice/open";
    try {
      const body = await fetch(`${base}/.well-known/security.txt`).then((r) => r.text());
      expect(body).toContain(`Contact: ${base}/alice/open/issues/new?sealed=1\n`);
      // The no-account report is not sealed: it is never offered beside
      // the contact, and the footer names it for what is not a vulnerability.
      expect(body).not.toContain(`${base}/alice/open/report`);
      expect(body.indexOf("/report")).toBeGreaterThan(body.indexOf("Not a vulnerability?"));
      // The configured contact still wins.
      process.env["FORGE_SECURITY_CONTACT"] = "mailto:security@example.org";
      try {
        const set = await fetch(`${base}/.well-known/security.txt`).then((r) => r.text());
        expect(set).toContain("Contact: mailto:security@example.org\n");
        expect(set).not.toContain("alice/open");
      } finally {
        delete process.env["FORGE_SECURITY_CONTACT"];
      }
    } finally {
      delete app.config.forgeRepo;
    }
  });

  test("the sealed form, signed out, offers the account only and comes back sealed", async () => {
    const form = await fetch(`${base}/alice/open/issues/new?sealed=1`).then((r) => r.text());
    expect(form).toContain("A sealed security report needs an account");
    expect(form).not.toContain(">Report a problem</a");
    // The password form brings the stranger back to the sealed form.
    const next = encodeURIComponent("/alice/open/issues/new?sealed=1");
    expect(form).toContain(`href="/signin?next=${next}"`);
    const plain = await fetch(`${base}/alice/open/issues/new`).then((r) => r.text());
    expect(plain).toContain("Opening an issue needs an account");
    expect(plain).toContain(">Report a problem</a");
    // Behind a platform edge, the edge's login comes back sealed too.
    app.config.edgeToken = "edge-secret-0123456789";
    try {
      const edge = await fetch(`${base}/alice/open/issues/new?sealed=1`).then((r) => r.text());
      expect(edge).toContain(`href="/_plat/login?rd=${next}"`);
    } finally {
      delete app.config.edgeToken;
    }
  });

  test("security.txt names a profile for a private or malformed forge repository", async () => {
    for (const named of ["alice/closed", "alice"]) {
      app.config.forgeRepo = named;
      try {
        const body = await fetch(`${base}/.well-known/security.txt`).then((r) => r.text());
        expect(body).toContain(`Contact: ${base}/alice\n`);
        expect(body).not.toContain("issues/new?sealed=1\n");
      } finally {
        delete app.config.forgeRepo;
      }
    }
  });

  test("change-password sends a password manager to the right page", async () => {
    const res = await fetch(`${base}/.well-known/change-password`, {
      redirect: "manual",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings/password");
  });

  test("releases.json is the shipped releases, newest first, in the shape a child reads", async () => {
    const res = await fetch(`${base}/releases.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as { releases: unknown[] };
    expect(doc.releases.length).toBe(shippedReleases().length);
    const read = parseReleases(doc, true);
    // A child reads the newest MAX_RELEASES; the record itself keeps every release,
    // and every entry, past those too, is in the child's shape.
    expect(read!.length).toBe(Math.min(doc.releases.length, MAX_RELEASES));
    // Read past the newest in pages, as a child would: one page holds at most
    // MAX_RELEASES, and the record outgrows two pages as releases ship.
    for (let at = MAX_RELEASES; at < doc.releases.length; at += MAX_RELEASES) {
      const page = doc.releases.slice(at, at + MAX_RELEASES);
      expect(parseReleases({ releases: page }, true)!.length).toBe(page.length);
    }
    expect(read![0]!.name).toBe(shippedReleases()[0]!.version);
    expect(read![0]!.url).toStartWith(`${base}/releases.json#`);
    // The verdict is the document's shape, not the machine's speed: a loaded
    // check machine gets a generous bound rather than a red lane (#5966).
  }, 30_000);

  test("releases.json carries a strong ETag, and a matching If-None-Match is a 304 with no body", async () => {
    const res = await fetch(`${base}/releases.json`);
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    await res.text();
    const same = await fetch(`${base}/releases.json`, {
      headers: { "if-none-match": etag },
    });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    expect(same.headers.get("etag")).toBe(etag);
    expect(same.headers.get("cache-control")).toBe(
      res.headers.get("cache-control"),
    );
    const other = await fetch(`${base}/releases.json`, {
      headers: { "if-none-match": '"nope"' },
    });
    expect(other.status).toBe(200);
  });

  test("a release tag read since is in releases.json at once, with a new ETag", async () => {
    const before = await fetch(`${base}/releases.json`);
    const etag = before.headers.get("etag")!;
    await before.text();
    setTagged([{ version: "9.9.9", migrations: 1, at: Date.now() }]);
    try {
      const after = await fetch(`${base}/releases.json`, { headers: { "if-none-match": etag } });
      expect(after.status).toBe(200);
      expect(after.headers.get("etag")).not.toBe(etag);
      const doc = (await after.json()) as { releases: { name: string }[] };
      expect(doc.releases[0]!.name).toBe("9.9.9");
    } finally {
      setTagged([]);
    }
  });

  test("robots keeps crawlers out of accounts and points at the sitemap", async () => {
    const body = await fetch(`${base}/robots.txt`).then((r) => r.text());
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /settings");
    expect(body).toContain("Disallow: /api/");
    expect(body).toContain(`Sitemap: ${base}/sitemap.xml`);
  });

  test("the sitemap lists what is public and nothing that is not", async () => {
    const res = await fetch(`${base}/sitemap.xml`);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const body = await res.text();
    expect(body).toContain(`<loc>${base}/</loc>`);
    expect(body).toContain(`<loc>${base}/alice/open</loc>`);
    expect(body).not.toContain("alice/closed");
  });

  test("GET /api/v1 names the forge and where its API, MCP, OAuth and docs live; POST is still no_route", async () => {
    for (const path of ["/api/v1", "/api/v1/"]) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-cache");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("content-security-policy")).not.toBeNull();
      const j = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(j).sort()).toEqual(["commit", "here", "llms", "mcp", "name", "oauth", "openapi", "version"]);
      expect(j["openapi"]).toBe(`${base}/api/v1/openapi.json`);
      expect(j["mcp"]).toBe(`${base}/mcp`);
      expect(j["oauth"]).toBe(`${base}/.well-known/oauth-protected-resource`);
      expect(j["llms"]).toBe(`${base}/llms.txt`);
      expect(j["here"]).toBe(`${base}/api/v1/here`);
    }
    expect((await fetch(`${base}/api/v1`, { method: "HEAD" })).status).toBe(200);
    const post = await fetch(`${base}/api/v1`, { method: "POST", headers: { origin: base } });
    expect(post.status).toBe(404);
    expect(((await post.json()) as { error?: string }).error).toBe("no_route");
    expect(await fetch(`${base}/llms.txt`).then((r) => r.text())).toContain(`${base}/api/v1 (the root`);
  });

  test("every MCP tool llms.txt offers without an account answers non-401 to an anonymous call, and the no-account section names only HTTP routes for finding things", async () => {
    const body = await fetch(`${base}/llms.txt`).then((r) => r.text());
    const tools = body.split("## MCP tools")[1]!.split("\n## ")[0]!;
    const open = [...tools.matchAll(/^- (\w+):.*\(no account\)/gm)].map((m) => m[1]!);
    expect(open).toContain("report");
    for (const name of open) {
      const res = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { repo: "nobody/none", title: "x" } } }),
      });
      expect(res.status).not.toBe(401);
    }
    const find = body.split("## Find things (no account)")[1]!.split("\n## ")[0]!;
    expect(find).toContain("with an account");
    expect(find).not.toContain("MCP: the tool");
    expect(find).toContain('MCP "search": with an account');
    const probe = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: { q: "" } } }),
    });
    expect(probe.status).toBe(401);
  });

  test("llms.txt says how to use the forge from a harness, with the endpoint built from the URL", async () => {
    const body = await fetch(`${base}/llms.txt`).then((r) => r.text());
    const section = body.slice(body.indexOf("## Use it from your harness"));
    expect(body.indexOf("## Offer a change")).toBeLessThan(body.indexOf("## Use it from your harness"));
    expect(section).toContain(`${base}/mcp`);
    expect(section).toContain(`${base}/.well-known/oauth-protected-resource`);
    expect(section).toContain("streamable HTTP");
    // trevato/forge is not here, so the lines come from the public upstream.
    expect(section).toContain("Claude Code plugin (source https://forge.open-platform.sh/trevato/forge.git");
    expect(section).not.toContain("needs that repository to be public");
  });

  test("sitemap and llms.txt are each built once for 50 requests, and a repository made private drops out at once", async () => {
    const mid = await createRepo(app, alice, {
      name: "midway",
      visibility: "public",
    });
    if (!mid.ok) throw new Error(String(mid.error));
    for (const path of ["/sitemap.xml", "/llms.txt"]) {
      const key = path === "/llms.txt" ? "llms" : "sitemap";
      await fetch(`${base}${path}`).then((r) => r.text());
      const before = listingBuilds[key];
      for (let i = 0; i < 50; i++)
        await fetch(`${base}${path}`).then((r) => r.text());
      expect(listingBuilds[key]).toBe(before);
    }
    const repo = getRepo(app.db, "alice", "midway")!;
    const done = await updateRepoSettings(app, alice, repo, {
      visibility: "private",
    });
    expect(done.ok).toBe(true);
    for (const path of ["/sitemap.xml", "/llms.txt"]) {
      const body = await fetch(`${base}${path}`).then((r) => r.text());
      expect(body).not.toContain("alice/midway");
      expect(body).toContain("alice/open");
    }
  });

  test("llms.txt answers a strong ETag and a 304, and a new public repository changes the ETag", async () => {
    const first = await fetch(`${base}/llms.txt`);
    const etag = first.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    await first.text();
    const again = await fetch(`${base}/llms.txt`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect(again.headers.get("vary")).toContain("Cookie");
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    const made = await createRepo(app, alice, { name: "etagged", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    // A new repository reaches the listing when its minute is up.
    forgetListings(app.db);
    const after = await fetch(`${base}/llms.txt`, { headers: { "if-none-match": etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etag);
    expect(await after.text()).toContain("alice/etagged");
  });

  test("llms.txt changes its ETag when the running commit changes", async () => {
    const saved = { c: process.env["FORGE_COMMIT"], a: process.env["FORGE_APP_COMMIT"] };
    try {
      delete process.env["FORGE_COMMIT"];
      process.env["FORGE_APP_COMMIT"] = "aaaaaaa1111111";
      const one = await fetch(`${base}/llms.txt`);
      await one.text();
      process.env["FORGE_APP_COMMIT"] = "bbbbbbb2222222";
      const two = await fetch(`${base}/llms.txt`, { headers: { "if-none-match": one.headers.get("etag")! } });
      expect(two.status).toBe(200);
      expect(two.headers.get("etag")).not.toBe(one.headers.get("etag"));
      expect(await two.text()).toContain("at bbbbbbb");
    } finally {
      for (const [k, v] of [["FORGE_COMMIT", saved.c], ["FORGE_APP_COMMIT", saved.a]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("llms.txt opens with the version, and the short commit only when one is known", async () => {
    const saved = {
      v: process.env["FORGE_VERSION"],
      c: process.env["FORGE_COMMIT"],
      a: process.env["FORGE_APP_COMMIT"],
    };
    try {
      process.env["FORGE_VERSION"] = "v1.2.3";
      delete process.env["FORGE_COMMIT"];
      process.env["FORGE_APP_COMMIT"] = "0123456789abcdef0123";
      let body = await fetch(`${base}/llms.txt`).then((r) => r.text());
      expect(body.split("\n")[2]).toBe("Running 1.2.3 at 0123456");
      delete process.env["FORGE_APP_COMMIT"];
      body = await fetch(`${base}/llms.txt`).then((r) => r.text());
      expect(body.split("\n")[2]).toBe("Running 1.2.3");
      expect(body.split("\n")[2]).not.toContain(" at ");
    } finally {
      for (const [k, v] of [
        ["FORGE_VERSION", saved.v],
        ["FORGE_COMMIT", saved.c],
        ["FORGE_APP_COMMIT", saved.a],
      ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test("a suspended account's repositories leave the cached listings at once", async () => {
    const bob = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bobby",
      email: "bobby@forge.local",
      password: "a-good-passphrase",
    });
    if (!bob.ok) throw new Error(bob.error);
    promote(app.db, bob.value);
    const r = await createRepo(app, bob.value, {
      name: "shown",
      visibility: "public",
    });
    if (!r.ok) throw new Error(String(r.error));
    const lists = async () =>
      (
        await Promise.all(
          ["/sitemap.xml", "/llms.txt"].map((p) =>
            fetch(`${base}${p}`).then((x) => x.text()),
          ),
        )
      ).join("\n");
    await lists();
    await suspendAccount(app, alice, "bobby", { confirmed: true });
    expect(await lists()).not.toContain("bobby/shown");
    unsuspendAccount(app, alice, "bobby");
    expect(await lists()).toContain("bobby/shown");
  });

  test("a retired organization's repositories leave the cached listings at once", async () => {
    const org = createOrg(app.db, "gone-co", alice.id);
    if (!org.ok) throw new Error(org.error);
    const made = await createRepo(app, org.value, {
      name: "ledger",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const lists = async () =>
      (
        await Promise.all(
          ["/sitemap.xml", "/llms.txt"].map((p) =>
            fetch(`${base}${p}`).then((x) => x.text()),
          ),
        )
      ).join("\n");
    // A new repository joins the listings when they are next read.
    forgetListings(app.db);
    expect(await lists()).toContain("gone-co/ledger");
    retireOrg(app.db, org.value.id, new Date().toISOString());
    expect(await lists()).not.toContain("gone-co/ledger");
  });

  test("an archived repository leaves the listings, and waking it brings it back", async () => {
    const made = await createRepo(app, alice, {
      name: "shelved",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    const repo = getRepo(app.db, "alice", "shelved")!;
    const lists = async () =>
      (
        await Promise.all(
          ["/sitemap.xml", "/llms.txt"].map((p) =>
            fetch(`${base}${p}`).then((x) => x.text()),
          ),
        )
      ).join("\n");
    forgetListings(app.db);
    expect(await lists()).toContain("alice/shelved");
    moveArchived(app.db, repo.id, true);
    const hidden = await lists();
    expect(hidden).not.toContain("alice/shelved");
    expect(hidden).toContain("alice/open");
    expect((await fetch(`${base}/alice/shelved`)).status).toBe(200);
    moveArchived(app.db, repo.id, false);
    expect(await lists()).toContain("alice/shelved");
  });

  test("the manifest is installable and its icons are real PNGs", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const m = (await res.json()) as {
      name: string;
      display: string;
      start_url: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
    // The splash and chrome are the default light theme's ground.
    expect(m.background_color).toBe("#fafafa");
    expect(m.theme_color).toBe("#fafafa");
    expect(m.icons.some((i) => i.purpose === "maskable")).toBe(true);
    for (const icon of m.icons) {
      const png = await fetch(`${base}${icon.src}`);
      expect(png.status).toBe(200);
      expect(png.headers.get("content-type")).toBe("image/png");
      const bytes = new Uint8Array(await png.arrayBuffer());
      const header = pngHeader(bytes);
      expect(header.ok).toBe(true);
      if (header.ok)
        expect(`${header.value.width}x${header.value.height}`).toBe(icon.sizes);
    }
    // The touch icon iOS asks for, and a size nobody asked for.
    expect((await fetch(`${base}/icons/forge-180.png`)).status).toBe(200);
    expect((await fetch(`${base}/icons/forge-64.png`)).status).toBe(404);
  });

  test("/favicon.ico answers with the 32px mark instead of a 404", async () => {
    const icon = await fetch(`${base}/icons/forge-32.png`);
    const fav = await fetch(`${base}/favicon.ico`);
    expect(fav.status).toBe(200);
    expect(fav.headers.get("content-type")).toBe("image/png");
    expect(fav.headers.get("cache-control")).toBe(icon.headers.get("cache-control"));
    expect(fav.headers.get("cache-control")).toContain("immutable");
    const bytes = new Uint8Array(await fav.arrayBuffer());
    expect(bytes).toEqual(new Uint8Array(await icon.arrayBuffer()));
    const header = pngHeader(bytes);
    expect(header.ok && `${header.value.width}x${header.value.height}`).toBe("32x32");
    // The security floor is on it like on every response.
    expect(fav.headers.get("x-content-type-options")).toBe("nosniff");
    expect(fav.headers.get("referrer-policy")).not.toBeNull();
    expect(fav.headers.get("content-security-policy")).not.toBeNull();
  });

  test("the mark is painted, not pasted: gradient inside, nothing outside", () => {
    const decoded = decodePng(markPng(64, "icon"));
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const px = (x: number, y: number) => {
      const i = (y * 64 + x) * 4;
      return [...decoded.value.rgba.subarray(i, i + 4)];
    };
    expect(px(0, 0)[3]).toBe(0); // the corner is transparent
    expect(px(32, 32)[3]).toBe(255); // the middle is solid
    const [r1, , b1] = px(16, 16);
    const [r2, , b2] = px(48, 48);
    expect(r2!).toBeGreaterThan(r1!); // accent → merged, corner to corner
    expect(b2!).toBeGreaterThanOrEqual(b1! - 2);
    const full = decodePng(markPng(64, "full"));
    expect(full.ok && full.value.rgba[3]).toBe(255); // edge to edge
  });

  test("every page carries the metadata a link needs to unfurl", async () => {
    const html = await fetch(`${base}/alice/open`).then((r) => r.text());
    expect(html).toMatch(/property="og:title"\s+content="open"/);
    expect(html).toContain(`content="${base}/alice/open"`);
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain(
      'rel="apple-touch-icon" href="/icons/forge-180.png"',
    );
    // A repository page carries its own card (/og/repo), not the icon.
    expect(html).toContain(`content="${base}/og/repo/alice~open.png"`);
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
    expect(html).toContain("viewport-fit=cover");
  });

  test("the page's own policy lets a browser read what it links", async () => {
    // default-src 'none' refuses a manifest like everything else; a link the
    // policy blocks is a link that does nothing. Same for the icons.
    const res = await fetch(`${base}/alice/open`);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toMatch(/img-src [^;]*'self'/);
  });

  test("the manifest and the front page carry the same sentence", async () => {
    const manifest = (await (await fetch(`${base}/manifest.webmanifest`)).json()) as { description: string };
    const html = await (await fetch(`${base}/`)).text();
    expect(manifest.description).toBe(SITE_LINE);
    // The front page's share line is its own; the sentence is in its body.
    const said = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(said).not.toBe("");
    expect(html).toContain(`<meta property="og:description" content="${said}"`);
    expect(html).toContain(SITE_LINE);
  });

  test("each web standard is served with its type and shape; the home page carries JSON-LD", async () => {
    const get = (path: string) => fetch(`${base}${path}`);
    const robots = await get("/robots.txt");
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(await robots.text()).toContain(`Sitemap: ${base}/sitemap.xml`);
    const sitemap = await get("/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toContain("xml");
    expect(await sitemap.text()).toContain("<urlset");
    const manifest = await get("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toMatch(/manifest\+json|json/);
    expect(((await manifest.json()) as { icons: unknown[] }).icons.length).toBeGreaterThan(0);
    const sec = await get("/.well-known/security.txt");
    expect(sec.headers.get("content-type")).toContain("text/plain");
    const secBody = await sec.text();
    expect(secBody).toMatch(/^Contact: \S+/m);
    const expires = /^Expires: (\S+)/m.exec(secBody)?.[1] ?? "";
    expect(Date.parse(expires)).toBeGreaterThan(Date.now());
    const llms = await get("/llms.txt");
    expect(llms.headers.get("content-type")).toContain("text/plain");
    expect((await llms.text()).startsWith("# ")).toBe(true);
    expect((await get("/favicon.ico")).headers.get("content-type")).toContain("image/png");
    expect((await get("/icons/forge-192.png")).headers.get("content-type")).toBe("image/png");
    const home = await (await get("/")).text();
    expect(home).toMatch(/name="theme-color"\s+media="\(prefers-color-scheme: light\)"/);
    expect(home).toMatch(/name="theme-color"\s+media="\(prefers-color-scheme: dark\)"/);
    const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(home)?.[1];
    expect(ld).toBeDefined();
    const graph = (JSON.parse(ld ?? "{}") as { "@graph": { "@type": string; url: string }[] })["@graph"];
    expect(graph.map((n) => n["@type"])).toEqual(["WebSite", "SoftwareApplication"]);
    expect(graph[0]?.url).toBe(`${base}/`);
  });

  test("the JSON-LD origin is the configured canonical URL, not the request's Host", async () => {
    app.config.url = "https://canon.example";
    try {
      const home = await fetch(`${base}/`, { headers: { host: "evil.example" } }).then((r) => r.text());
      const ld = /<script type="application\/ld\+json">([^<]*)<\/script>/.exec(home)?.[1] ?? "";
      expect(ld).toContain("https://canon.example/");
      expect(ld).not.toContain("evil.example");
      expect(ld).not.toContain(base);
    } finally {
      delete app.config.url;
    }
  });
});
