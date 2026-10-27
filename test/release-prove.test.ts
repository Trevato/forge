/**
 * A new version proves itself once against the public URL: a pass is kept,
 * a failure is a `release` card naming the first failing check, the same
 * version on restart does not run again, and ten minutes of silence is
 * "unproven" (#2574). A fake fetch plays the public URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastProof, proofNeed, proveRelease } from "../src/release/prove.ts";
import { owned } from "../src/crew/incidents.ts";

const CSS = '<html><link rel="stylesheet" href="/a.css"></html>';

function site(version: string, over: Record<string, () => Response> = {}) {
  const hits: string[] = [];
  const fake = (async (input: string | URL) => {
    const path = new URL(String(input)).pathname;
    hits.push(path);
    const made = over[path]?.();
    if (made) return made;
    if (path === "/healthz") return new Response("ok", { headers: { "x-forge-version": version } });
    if (path === "/") return new Response(CSS, { headers: { "content-type": "text/html" } });
    if (path === "/a.css") return new Response("a{}", { headers: { "content-type": "text/css" } });
    if (path === "/board") return new Response(null, { status: 302, headers: { location: "/signin" } });
    if (path === "/sw.js")
      return new Response('if (r.mode === "navigate") { e.respondWith(fetch(r)); return; }', {
        headers: { "content-type": "text/javascript" },
      });
    return new Response("no", { status: 404 });
  }) as unknown as typeof fetch;
  return { fake, hits };
}

describe("proving a release", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "forge-prove-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const run = (version: string, fake: typeof fetch, extra = {}) =>
    proveRelease({ dataDir: dir, version, url: "https://forge.test", fetch: fake, sleep: async () => {}, ...extra });

  test("a pass is recorded with the version and raises nothing", async () => {
    const { fake } = site("1.2.3");
    const p = await run("1.2.3", fake);
    expect(p?.ok).toBe(true);
    expect(lastProof(dir)?.version).toBe("1.2.3");
    expect(proofNeed(dir)).toBeUndefined();
  });

  test("an app host that answers as the forge fails the proof (#6726)", async () => {
    const { fake: base } = site("1.2.6");
    const fake = (async (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).host === "notes.apps.test"
        ? new Response("<title>forge</title>", { headers: { "content-type": "text/html" } })
        : base(input, init)) as unknown as typeof fetch;
    const p = await run("1.2.6", fake, { appHost: "https://notes.apps.test" });
    expect(p?.ok).toBe(false);
    expect(p?.failure).toContain("an app host answered with the forge's page");
    const good = await run("1.2.7", site("1.2.7").fake, { appHost: "https://notes.apps.test" });
    expect(good?.ok).toBe(true);
  });

  test("a failure raises the cause once, naming the first failing check", async () => {
    const { fake } = site("1.2.4", { "/a.css": () => new Response("x", { status: 500 }) });
    await run("1.2.4", fake);
    const need = proofNeed(dir)!;
    expect(need.sentence).toContain("Release 1.2.4 is unproven");
    expect(need.sentence).toContain("/a.css");
    expect(owned("release")).toBe(true);
    // the same version again does not run, so the card is not re-raised
    const again = site("1.2.4");
    expect(await run("1.2.4", again.fake)).toBeUndefined();
    expect(again.hits).toEqual([]);
    expect(proofNeed(dir)?.since).toBe(need.since);
  });

  test("the same version on restart does not run again", async () => {
    const first = site("2.0.0");
    await run("2.0.0", first.fake);
    const second = site("2.0.0");
    expect(await run("2.0.0", second.fake)).toBeUndefined();
    expect(second.hits).toEqual([]);
  });

  test("a later version that passes clears the card", async () => {
    await run("3.0.0", site("3.0.0", { "/": () => new Response("x", { status: 500 }) }).fake);
    expect(proofNeed(dir)).toBeDefined();
    await run("3.0.1", site("3.0.1").fake);
    expect(proofNeed(dir)).toBeUndefined();
  });

  test("it gives up after 10 minutes as unproven", async () => {
    let t = 0;
    const old = site("0.9.0"); // the old version keeps answering
    const p = await run("1.0.0", old.fake, { now: () => t, sleep: async (ms: number) => void (t += ms) });
    expect(p?.ok).toBe(false);
    expect(t).toBeLessThanOrEqual(10 * 60_000);
    expect(t).toBeGreaterThan(9 * 60_000);
    expect(proofNeed(dir)?.sentence).toBe("Release 1.0.0 is unproven: the public URL never answered as 1.0.0.");
    expect(old.hits.every((h) => h === "/healthz")).toBe(true);
  });

  test("an unstamped forge proves nothing", async () => {
    const s = site("dev");
    expect(await run("dev", s.fake)).toBeUndefined();
    expect(s.hits).toEqual([]);
  });
});
