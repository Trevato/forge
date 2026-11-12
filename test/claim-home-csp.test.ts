/**
 * /claim and a spawned forge's home load without a console error (#11397).
 * Over real HTTP, against the page's own Content-Security-Policy: every script
 * (inline or by src), stylesheet, manifest, icon, sprite and form target the
 * markup names is admitted by the directive that governs it, and each answers
 * 200; and the beacon's POST, as a browser on the forge's public https origin
 * would send it, is accepted. It does not run the scripts: only a browser
 * shows what they log.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** The source list of one directive of a policy (falling back to default-src). */
function sources(csp: string, directive: string): string[] {
  const all = csp.split(";").map((d) => d.trim().split(/\s+/));
  const found = all.find((d) => d[0] === directive) ?? all.find((d) => d[0] === "default-src") ?? [];
  return found.slice(1);
}

/** Whether a directive's source list admits a URL, as seen from `origin`. */
function admits(list: string[], raw: string, origin: string): boolean {
  const url = new URL(raw, origin);
  if (url.protocol === "data:") return list.includes("data:");
  return list.some((s) => (s === "'self'" ? url.origin === origin : s.replace(/\/$/, "") === url.origin));
}

/** The inline scripts and script srcs a policy does not admit, named; JSON data blocks never execute. */
function scriptsNotAllowed(html: string, csp: string, origin: string): string[] {
  const list = sources(csp, "script-src");
  const bad: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    const type = /\btype="([^"]*)"/i.exec(attrs)?.[1] ?? "";
    if (type === "application/json" || type === "application/ld+json") continue;
    const src = /\bsrc="([^"]*)"/i.exec(attrs)?.[1];
    if (src !== undefined) {
      if (!admits(list, src, origin)) bad.push(`src ${src}`);
      continue;
    }
    const hash = `'sha256-${new Bun.CryptoHasher("sha256").update(m[2] ?? "").digest("base64")}'`;
    if (!list.includes(hash)) bad.push(`inline ${(m[2] ?? "").slice(0, 40)}`);
  }
  return bad;
}

/** Every load the markup names, with the directive that governs it. */
function loadsOf(html: string): { directive: string; href: string }[] {
  const out: { directive: string; href: string }[] = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const rel = /\brel="([^"]*)"/i.exec(m[1] ?? "")?.[1] ?? "";
    const href = /\bhref="([^"]*)"/i.exec(m[1] ?? "")?.[1];
    if (href === undefined) continue;
    if (rel === "stylesheet") out.push({ directive: "style-src", href });
    else if (rel === "manifest") out.push({ directive: "manifest-src", href });
    else if (rel === "icon" || rel === "apple-touch-icon") out.push({ directive: "img-src", href });
  }
  for (const m of html.matchAll(/<use\b[^>]*\bhref="([^"]*)"/gi)) out.push({ directive: "img-src", href: m[1]! });
  for (const m of html.matchAll(/<form\b[^>]*\baction="([^"]*)"/gi)) out.push({ directive: "form-action", href: m[1]! });
  return out;
}

const PUBLIC = "https://maria--forge.test";

describe("/claim and a spawned forge's home against their own CSP", () => {
  let dir = "";
  let parent: App;
  let parentServers: Servers;
  let child: App;
  let childServers: Servers;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-claim-csp-"));
    parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
    const alice = await createUser(parent.db, {
      origin: "seed", trusted: true, username: "alice", email: "a@x.test",
      password: "a-long-claim-passphrase", isAdmin: true,
    });
    if (!alice.ok) throw new Error("user");
    const rw = createToken(parent.db, alice.value.id, "rw", "rw").token;
    parentServers = await serve(parent);
    const made = await fetch(`${parentServers.url}/api/v1/forges`, {
      method: "POST",
      headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "maria", apps: [], dryRun: false }),
    });
    if (made.status !== 201) throw new Error(`spawn ${made.status} ${await made.text()}`);
    const body = (await made.json()) as { bodyId: string };
    // A spawned forge knows its public https address, as a hosted child does.
    child = createApp({ dataDir: childDirOf(parent, body.bodyId), url: PUBLIC, port: 0 });
    await firstBoot(child);
    childServers = await serve(child);
  }, 60_000);

  afterAll(async () => {
    childServers.stop();
    child.close();
    parentServers.stop();
    parent.close();
    await rm(dir, { recursive: true, force: true });
  });

  for (const path of ["/claim", "/"]) {
    test(`${path}: every script and load is admitted by its own policy, and answers`, async () => {
      const res = await fetch(`${childServers.url}${path}`);
      expect(res.status).toBe(200);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).not.toBe("");
      const html = await res.text();
      expect(scriptsNotAllowed(html, csp, PUBLIC)).toEqual([]);
      const loads = loadsOf(html);
      expect(loads.length).toBeGreaterThan(3);
      for (const { directive, href } of loads) {
        expect(`${directive} ${href} ${admits(sources(csp, directive), href, PUBLIC)}`).toBe(`${directive} ${href} true`);
        if (directive === "form-action" || href.startsWith("data:")) continue;
        const got = await fetch(`${childServers.url}${new URL(href, PUBLIC).pathname}${new URL(href, PUBLIC).search}`);
        expect(`${href} ${got.status}`).toBe(`${href} 200`);
      }
      for (const m of html.matchAll(/<script\b[^>]*\bsrc="([^"]*)"/gi)) {
        const got = await fetch(`${childServers.url}${m[1]}`);
        expect(`${m[1]} ${got.status}`).toBe(`${m[1]} 200`);
      }
    });

    test(`${path}: the beacon's POST from the public origin is accepted`, async () => {
      const sent = await fetch(`${childServers.url}/_measure`, {
        method: "POST",
        headers: { origin: PUBLIC },
        body: JSON.stringify({ path, ttfb: 1, load: 1, lcp: 1, inp: 0, cls: 0, ref: "", q: "", out: "" }),
      });
      expect(sent.status).toBe(204);
    });
  }
});
