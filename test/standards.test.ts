/**
 * The well-known files every forge serves by default, from its own facts:
 * a security contact, a sitemap of what is public and nothing that is not,
 * an installable manifest with real icons, and the metadata a link needs
 * to unfurl.
 */
import { MAX_RELEASES, parseReleases } from "../src/core/parent_releases.ts";
import releasesFile from "../src/core/releases.json" with { type: "json" };
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
import { getRepo } from "../src/core/repos.ts";
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
  });

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
    expect(doc.releases.length).toBe(releasesFile.releases.length);
    const read = parseReleases(doc, true);
    // A child reads the newest MAX_RELEASES; the record itself keeps every release,
    // and every entry, past those too, is in the child's shape.
    expect(read!.length).toBe(Math.min(doc.releases.length, MAX_RELEASES));
    const rest = doc.releases.slice(MAX_RELEASES);
    expect(parseReleases({ releases: rest }, true)!.length).toBe(rest.length);
    expect(read![0]!.name).toBe(releasesFile.releases[0]!.version);
    expect(read![0]!.url).toStartWith(`${base}/releases.json#`);
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

  test("the manifest is installable and its icons are real PNGs", async () => {
    const res = await fetch(`${base}/manifest.webmanifest`);
    expect(res.headers.get("content-type")).toContain(
      "application/manifest+json",
    );
    const m = (await res.json()) as {
      name: string;
      display: string;
      start_url: string;
      icons: { src: string; sizes: string; purpose?: string }[];
    };
    expect(m.display).toBe("standalone");
    expect(m.start_url).toBe("/");
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
});
