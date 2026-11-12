/**
 * A page that loads with no console error (#11345). The probe saw one error on
 * `/claim` and one on a new forge's home; its text was not kept, so no cause is
 * named here from memory. What can be checked without a browser is checked:
 * the Permissions-Policy names only powers current browsers recognise (it used
 * to carry `interest-cohort`, which Chromium reports as an unrecognised
 * feature on every document), every inline style is named in the CSP, no
 * inline script or handler exists, every same-origin address answers, and
 * every element a page script looks up by a literal is in the served HTML.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childDirOf } from "../src/actions/spawn.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { firstBoot } from "../src/spawn/first-boot.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

/** The powers a Permissions-Policy header may name: every one a current browser recognises. */
const KNOWN_POWERS = new Set(["camera", "microphone", "geolocation", "payment", "usb", "serial", "hid", "bluetooth"]);

let dir = "";
let parent: App;
let child: App;
let parentServers: Servers;
let childServers: Servers;
let cookie = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-console-clean-"));
  parent = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const alice = await createUser(parent.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-claim-passphrase", isAdmin: true });
  if (!alice.ok) throw new Error("user");
  const token = createToken(parent.db, alice.value.id, "rw", "rw").token;
  parentServers = await serve(parent);
  const made = await fetch(`${parentServers.url}/api/v1/forges`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "maria", apps: [], dryRun: false }),
  });
  if (made.status !== 201) throw new Error(`spawn ${made.status}`);
  const body = (await made.json()) as { bodyId: string };
  child = createApp({ dataDir: childDirOf(parent, body.bodyId), port: 0 });
  await firstBoot(child);
  childServers = await serve(child);
  const owner = await createUser(child.db, { origin: "claim", trusted: true, username: "dana", email: "d@x.test", password: "a-long-claim-passphrase", isAdmin: true });
  if (!owner.ok) throw new Error("owner");
  cookie = `forge_session=${createSession(child.db, owner.value.id).token}`;
}, 60_000);

afterAll(async () => {
  childServers.stop();
  child.close();
  parentServers.stop();
  parent.close();
  await rm(dir, { recursive: true, force: true });
});

test("the Permissions-Policy names only powers a browser recognises", async () => {
  const res = await fetch(`${childServers.url}/claim`);
  const policy = res.headers.get("permissions-policy") ?? "";
  const named = policy.split(",").map((p) => p.trim().split("=")[0]!);
  expect(named.length).toBeGreaterThan(0);
  expect(named.filter((p) => !KNOWN_POWERS.has(p))).toEqual([]);
});

for (const [name, path, signedIn] of [
  ["/claim", "/claim", false],
  ["a new forge's home, signed in", "/", true],
  ["a new forge's home, signed out", "/", false],
] as const) {
  test(`${name} holds nothing its own policy refuses, and every address it names answers`, async () => {
    const headers = signedIn ? { cookie } : {};
    const res = await fetch(`${childServers.url}${path}`, { headers });
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    const html = await res.text();
    // Every inline <style> is named by hash.
    for (const m of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
      const hash = new Bun.CryptoHasher("sha256").update(m[1]!).digest("base64");
      expect(csp).toContain(`'sha256-${hash}'`);
    }
    // No script runs inline (data blocks are not executed), no style attribute, no handler.
    const inline = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]!).filter((a) => !/\bsrc=/.test(a) && !/type="application\/(ld\+)?json"/.test(a));
    expect(inline).toEqual([]);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    // Every same-origin address it names answers (the form's POST-only door excepted).
    const refs = new Set([...html.matchAll(/\b(?:src|href|data-live-src|data-refresh)="(\/[^"#]*)"/g)].map((m) => m[1]!));
    for (const ref of refs) {
      const got = await fetch(`${childServers.url}${ref}`, { headers: { ...headers, accept: "text/html" } });
      expect(`${ref} ${got.status}`).toBe(`${ref} ${got.ok ? got.status : 200}`);
      await got.body?.cancel();
    }
  });
}

/**
 * Lookups that may miss on a page and have been read to tolerate it: the
 * shell reaches `[data-box]` only after `pageBox()` found one; the live
 * refresh reads `#app-head`, `#app-previews` and `.sprite` to compare and
 * skips the swap (`if (!mine || !theirs) return`, `theirSprite && mySprite`)
 * when they are absent. Anything else that misses fails the test.
 */
const TOLERATED = new Set(["[data-box]", "app-head", "app-previews", ".sprite"]);

/** Every script a page loads, as source, in document order. */
async function scriptsOf(base: string, html: string): Promise<{ src: string; code: string }[]> {
  const out: { src: string; code: string }[] = [];
  for (const m of html.matchAll(/<script[^>]*\ssrc="(\/[^"]+)"/g)) {
    const res = await fetch(`${base}${m[1]}`);
    expect(res.status).toBe(200);
    out.push({ src: m[1]!, code: await res.text() });
  }
  return out;
}

/** Does the served HTML hold an element this literal selector finds? Only simple selectors are judged. */
function selectorFound(html: string, sel: string): boolean | null {
  const id = /^#([\w-]+)$/.exec(sel);
  if (id) return html.includes(`id="${id[1]}"`);
  const cls = /^\.([\w-]+)$/.exec(sel);
  if (cls) return new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(html);
  const attr = /^(\w*)\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(sel);
  if (attr) {
    const [, tag, name, value] = attr;
    const needle = value === undefined ? ` ${name}` : ` ${name}="${value}"`;
    return new RegExp(`<${tag || "[a-z]+"}\\b[^>]*${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(html);
  }
  return null;
}

for (const [name, path, signedIn] of [
  ["/claim", "/claim", false],
  ["a new forge's home, signed in", "/", true],
  ["a new forge's home, signed out", "/", false],
] as const) {
  test(`${name}: every element a page script looks up by a literal is in the served HTML`, async () => {
    const html = await (await fetch(`${childServers.url}${path}`, { headers: signedIn ? { cookie } : {} })).text();
    const scripts = await scriptsOf(childServers.url, html);
    expect(scripts.length).toBeGreaterThan(0);
    let looked = 0;
    const missing: string[] = [];
    for (const { src, code } of scripts) {
      // Only getElementById and querySelector can hand back null (querySelectorAll gives an empty list).
      for (const m of code.matchAll(/\b(?:doc|document|D|d)\s*\.\s*(getElementById|querySelector)\(\s*(["'])([^"'+]+)\2\s*\)/g)) {
        looked++;
        const found = m[1] === "getElementById" ? html.includes(`id="${m[3]}"`) : selectorFound(html, m[3]!);
        if (found === false && !TOLERATED.has(m[3]!) && !guarded(code, m.index!, m[0].length)) missing.push(`${src}: ${m[3]}`);
      }
    }
    expect(missing).toEqual([]);
    expect(looked).toBeGreaterThan(0);
  });
}

/** A lookup that misses throws only when its result is used untested: dereferenced on the spot, or through a variable never checked. */
function guarded(code: string, at: number, len: number): boolean {
  const before = code.slice(Math.max(0, at - 120), at);
  const after = code.slice(at + len, at + len + 2500);
  if (/(?:\bif\s*\(\s*!?|&&\s*|\|\|\s*|\?\s*)$/.test(before)) return true;
  if (/^\s*[.\[]/.test(after)) return false;
  const v = /(?:var|let|const)\s+(\w+)\s*=\s*(?:[\w.]+\s*(?:&&|\|\|)\s*)?(?:\(?[\w.$]+\s*\)?\s*\.)?$/.exec(before)?.[1] ?? /(\w+)\s*=\s*$/.exec(before)?.[1];
  if (!v) return true;
  return new RegExp(`(\\bif\\s*\\(\\s*!?${v}\\b|!${v}\\b|\\b${v}\\s*(&&|\\|\\||\\?)|\\b${v}\\s*(!==?|===?)\\s*null|\\bif\\s*\\(\\s*${v}\\s*\\))`).test(after);
}

test("the claim page's own elements are present", async () => {
  const html = await (await fetch(`${childServers.url}/claim`)).text();
  for (const id of ["claim-token-field", "passkey-make", "passkey-make-note"]) expect(html).toContain(`id="${id}"`);
  expect(html).toContain('name="token"');
});
