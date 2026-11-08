/**
 * A new version proves itself once against the public URL: a pass is kept,
 * a failure is a `release` card naming the first failing check, the same
 * version on restart does not run again, and ten minutes of silence is
 * "unproven" (#2574). A fake fetch plays the public URL.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastProof, proofDue, proofNeed, proveRelease, proveRunning, retryAfter, RETRY_MS, startProving, type Proof } from "../src/release/prove.ts";
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
    if (path === "/explore" || path === "/search" || path === "/boards") return new Response("page");
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
    proveRelease({ dataDir: dir, version, url: "https://forge.test", fetch: fake, sleep: async () => {}, heavy: { watchMs: 30, pollMs: 5 }, ...extra });

  test("a pass is recorded with the version and raises nothing", async () => {
    const { fake } = site("1.2.3");
    const p = await run("1.2.3", fake);
    expect(p?.ok).toBe(true);
    expect(lastProof(dir)?.version).toBe("1.2.3");
    expect(proofNeed(dir)).toBeUndefined();
  });

  test("the go-live proof loads the heavy pages and watches /healthz without being asked", async () => {
    const { fake: base, hits } = site("1.2.5");
    const fake = (async (input: string | URL, init?: RequestInit) =>
      new URL(String(input)).pathname === "/healthz" && hits.includes("/explore") ? new Response("down", { status: 503 }) : base(input, init)) as unknown as typeof fetch;
    const p = await proveRelease({ dataDir: dir, version: "1.2.5", url: "https://forge.test", fetch: fake, sleep: async () => {} });
    expect(p?.ok).toBe(false);
    expect(p?.failure).toContain("/healthz");
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
    expect(proofNeed(dir)?.sentence).toStartWith("Release 1.0.0 is unproven: the public URL never answered as 1.0.0. It is proven again at ");
    expect(old.hits.every((h) => h === "/healthz")).toBe(true);
  });

  test("a failed version is proven again after RETRY_MS, and a pass clears the card (#7622)", async () => {
    let t = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: () => t };
    await run("4.0.0", site("4.0.0", { "/healthz": () => new Response("slow", { status: 503, headers: { "x-forge-version": "4.0.0" } }) }).fake, clock);
    const need = proofNeed(dir)!;
    expect(need.sentence).toContain("Release 4.0.0 is unproven");
    t += RETRY_MS - 1;
    const early = site("4.0.0");
    expect(await run("4.0.0", early.fake, clock)).toBeUndefined();
    expect(early.hits).toEqual([]);
    t += 1;
    expect((await run("4.0.0", site("4.0.0").fake, clock))?.ok).toBe(true);
    expect(proofNeed(dir)).toBeUndefined();
    // proven now, so never again for this version
    t += 10 * RETRY_MS;
    const later = site("4.0.0");
    expect(await run("4.0.0", later.fake, clock)).toBeUndefined();
    expect(later.hits).toEqual([]);
  });

  test("a retry that fails again keeps the card's first since", async () => {
    let t = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: () => t };
    const broken = () => site("4.1.0", { "/": () => new Response("x", { status: 500 }) }).fake;
    await run("4.1.0", broken(), clock);
    const since = proofNeed(dir)!.since;
    t += RETRY_MS;
    expect((await run("4.1.0", broken(), clock))?.ok).toBe(false);
    expect(proofNeed(dir)?.since).toBe(since);
    expect(lastProof(dir)?.at).not.toBe(since);
  });

  test("each failure in a row doubles the wait, up to an hour", async () => {
    expect([1, 2, 3, 4, 5, 99].map((n) => retryAfter(n))).toEqual([5, 10, 20, 40, 60, 60].map((m) => m * 60_000));
    let t = Date.parse("2026-10-28T12:00:00Z");
    const clock = { now: () => t };
    const broken = () => site("4.3.0", { "/": () => new Response("x", { status: 500 }) }).fake;
    await run("4.3.0", broken(), clock);
    expect(lastProof(dir)?.failures).toBe(1);
    expect(proofNeed(dir)?.sentence).toEndWith(" It is proven again at 12:05 UTC.");
    t += RETRY_MS;
    await run("4.3.0", broken(), clock);
    expect(lastProof(dir)?.failures).toBe(2);
    // the card names the later try: 12:05 plus ten minutes
    expect(proofNeed(dir)?.sentence).toEndWith(" It is proven again at 12:15 UTC.");
    // the third try waits ten minutes, not five
    t += RETRY_MS;
    const early = site("4.3.0");
    expect(await run("4.3.0", early.fake, clock)).toBeUndefined();
    expect(early.hits).toEqual([]);
    t += RETRY_MS;
    await run("4.3.0", broken(), clock);
    expect(lastProof(dir)?.failures).toBe(3);
  });

  test("a proof kept before failures were counted is retried as a first failure", () => {
    const at = "2026-10-28T12:00:00.000Z";
    const old: Proof = { version: "4.4.0", at, ok: false, failure: "x" };
    expect(proofDue(old, "4.4.0", Date.parse(at) + RETRY_MS - 1)).toBe(false);
    expect(proofDue(old, "4.4.0", Date.parse(at) + RETRY_MS)).toBe(true);
    expect(proofDue({ ...old, ok: true }, "4.4.0", Date.parse(at) + 100 * RETRY_MS)).toBe(false);
    expect(proofDue(old, "4.5.0", Date.parse(at))).toBe(true);
  });

  test("startProving proves at once, schedules the next tick only when one ends, and stops", async () => {
    const queued: { fn: () => void; ms: number }[] = [];
    const schedule = (fn: () => void, ms: number) => {
      const job = { fn, ms };
      queued.push(job);
      return () => void queued.splice(queued.indexOf(job), 1);
    };
    const results: (Proof | undefined)[] = [{ version: "4.2.0", at: "a", ok: false, failure: "x" }, undefined, { version: "4.2.0", at: "b", ok: true }];
    let finish: (() => void) | undefined;
    let proofs = 0;
    const prove = () => {
      proofs++;
      return new Promise<Proof | undefined>((resolve) => (finish = () => resolve(results.shift())));
    };
    const heard: Proof[] = [];
    const stop = startProving({ dataDir: dir, version: "4.2.0", url: "https://forge.test" }, (p) => heard.push(p), 60_000, schedule, prove);
    expect(proofs).toBe(1);
    expect(queued).toEqual([]); // nothing scheduled while a proof runs
    for (let i = 0; i < 3; i++) {
      finish!();
      await Bun.sleep(0);
      expect(queued.map((q) => q.ms)).toEqual([60_000]);
      if (i < 2) queued.shift()!.fn();
    }
    expect(proofs).toBe(3);
    expect(heard.map((p) => p.ok)).toEqual([false, true]);
    stop();
    expect(queued).toEqual([]);
  });

  test("proveRunning, what main.ts boots, logs each verdict that ran as one release proof line", async () => {
    const lines: [string, unknown][] = [];
    const queued: (() => void)[] = [];
    const results: (Proof | undefined)[] = [{ version: "4.6.0", at: "a", ok: false, failure: "slow" }, undefined, { version: "4.6.0", at: "b", ok: true }];
    const stop = proveRunning(
      { dataDir: dir, version: "4.6.0", url: "https://forge.test" },
      { info: (msg, fields) => void lines.push([msg, fields]) },
      60_000,
      (fn) => (queued.push(fn), () => {}),
      async () => results.shift(),
    );
    for (let i = 0; i < 3; i++) {
      await Bun.sleep(0);
      queued.shift()?.();
    }
    await Bun.sleep(0);
    stop();
    expect(lines).toEqual([
      ["release proof", { version: "4.6.0", ok: "false", failure: "slow" }],
      ["release proof", { version: "4.6.0", ok: "true" }],
    ]);
  });

  test("an unstamped forge proves nothing", async () => {
    const s = site("dev");
    expect(await run("dev", s.fake)).toBeUndefined();
    expect(s.hits).toEqual([]);
  });
});

describe("a slow-only proof is asked again sooner (#9238)", () => {
  const slowProof: Proof = { version: "1.0.0", at: "2026-11-03T03:00:00.000Z", ok: false, failure: "https://x/healthz as desktop /healthz took 2032 ms, over 1000 ms (status 200)", failures: 1, slow: true };
  const at = Date.parse(slowProof.at);
  test("retryAfter", () => {
    expect(retryAfter(1, true)).toBe(60_000);
    expect(retryAfter(3, true)).toBe(180_000);
    expect(retryAfter(5, true)).toBe(300_000);
    expect(retryAfter(1)).toBe(RETRY_MS);
  });
  test("proofDue is due after a minute for slow, not for the same text without the flag", () => {
    expect(proofDue(slowProof, "1.0.0", at + 61_000)).toBe(true);
    const plain: Proof = { ...slowProof, slow: false };
    expect(proofDue(plain, "1.0.0", at + 61_000)).toBe(false);
  });
  test("proofNeed says the shortened time", () => {
    const dir = mkdtempSync(join(tmpdir(), "prove-"));
    try {
      mkdirSync(join(dir, "release"), { recursive: true });
      writeFileSync(join(dir, "release", "proof.json"), JSON.stringify(slowProof));
      expect(proofNeed(dir)!.sentence).toEndWith("It is proven again at 03:01 UTC.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("an empty-body proof is asked again sooner (#9358)", () => {
  test("a version whose /explore answers empty twice is due again after a minute, not five", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-prove-"));
    try {
      const { fake } = site("5.0.0", { "/explore": () => new Response("", { status: 200 }) });
      const p = await proveRelease({ dataDir: dir, version: "5.0.0", url: "https://forge.test", fetch: fake, sleep: async () => {}, heavy: { watchMs: 30, pollMs: 5 } });
      expect(p?.ok).toBe(false);
      expect(p?.failure).toContain("empty body");
      expect(p?.slow).toBe(true);
      expect(proofDue(p, "5.0.0", Date.parse(p!.at) + 61_000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a hung proof is asked again sooner (#9482)", () => {
  test("a version whose /explore never answers is due again after a minute, not five", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forge-prove-"));
    try {
      const timeout = (): Response => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      };
      const { fake } = site("5.1.0", { "/explore": timeout });
      const p = await proveRelease({ dataDir: dir, version: "5.1.0", url: "https://forge.test", fetch: fake, sleep: async () => {}, heavy: { watchMs: 30, pollMs: 5 } });
      expect(p?.ok).toBe(false);
      expect(p?.failure).toContain("did not answer");
      expect(p?.slow).toBe(true);
      expect(proofDue(p, "5.1.0", Date.parse(p!.at) + 61_000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
