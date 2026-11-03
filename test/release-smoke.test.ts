import { afterEach, expect, test } from "bun:test";
import { HEAVY_PAGES, forgeMs, smoke } from "../src/release/smoke.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

/** A healthy forge; `delay` says how long a path waits on its nth hit; `over` answers some paths its own way, `/boards` waits `boardsMs`. */
function forge(boardsMs: number, seen: string[] = [], over: (path: string) => Response | undefined = () => undefined, delay: (path: string, hit: number) => number = () => 0) {
  const hits: Record<string, number> = {};
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(path);
      const hit = (hits[path] = (hits[path] ?? 0) + 1);
      await Bun.sleep(delay(path, hit));
      const made = over(path);
      if (made) return made;
      if (path === "/") return new Response('<link rel="stylesheet" href="/a.css">', { headers: { "content-type": "text/html" } });
      if (path === "/a.css") return new Response("body{margin:0}", { headers: { "content-type": "text/css" } });
      if (path === "/sw.js") return new Response("if (r.mode === 'navigate') { e.respondWith(fetch(r)); return; }", { headers: { "content-type": "text/javascript" } });
      if (path === "/boards") await Bun.sleep(boardsMs);
      return new Response("page " + path, { headers: { "x-forge-version": "v1" } });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

const heavy = { watchMs: 300, pollMs: 50, slowMs: 200 };

test("a healthy forge passes the heavy pages and the /healthz watch", async () => {
  const seen: string[] = [];
  const failures = await smoke(forge(0, seen), "t", { heavy });
  expect(failures.filter((f) => HEAVY_PAGES.some((page) => f.url.endsWith(page)) || f.url.endsWith("/healthz"))).toEqual([]);
  for (const page of HEAVY_PAGES) expect(seen).toContain(new URL(page, "http://x").pathname);
  expect(seen.filter((p) => p === "/healthz").length).toBeGreaterThan(4);
});

test("a /boards that blocks fails the smoke and names /boards", async () => {
  const failures = await smoke(forge(500), "t", { heavy });
  const slow = failures.find((f) => f.url.endsWith("/boards") && f.why.includes("/boards"));
  expect(slow).toBeDefined();
});

test("a page that answers 500 fails, named", async () => {
  const failures = await smoke(forge(0, [], (p) => (p === "/explore" ? new Response("x", { status: 500 }) : undefined)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/explore") && f.status === 500)).toBe(true);
});

test("without heavy, the pages are not loaded", async () => {
  const seen: string[] = [];
  expect(await smoke(forge(0, seen), "t")).toEqual([]);
  expect(seen).not.toContain("/explore");
});

test("a /healthz that reports another version mid-watch fails", async () => {
  let n = 0;
  const base = forge(0, [], (p) => (p === "/healthz" && ++n > 3 ? new Response("x", { headers: { "x-forge-version": "old" } }) : undefined));
  const failures = await smoke(base, "t", { version: "v1", heavy });
  expect(failures.some((f) => f.url.endsWith("/healthz") && f.why.includes("old"))).toBe(true);
});

test("a forge without the default repository is not failed for it, but a named one is", async () => {
  const gone = (p: string) => (p.startsWith("/trevato/") ? new Response("no", { status: 404 }) : undefined);
  expect(await smoke(forge(0, [], gone), "t", { heavy })).toEqual([]);
  const named = await smoke(forge(0, [], gone), "t", { heavy: { ...heavy, repo: "/trevato/other" } });
  expect(named.some((f) => f.url.endsWith("/trevato/other"))).toBe(true);
});

test("the watch is skipped when the checks already failed", async () => {
  const seen: string[] = [];
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => (seen.push(new URL(req.url).pathname), new Response("x", { status: 500 })) });
  await smoke(`http://127.0.0.1:${server.port}`, "t", { heavy: { ...heavy, watchMs: 5_000 } });
  expect(seen).not.toContain("/explore");
});

test("a first load that is slow once is asked again and passes (#7198)", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/boards" && hit === 1 ? 300 : 0)), "t", { heavy });
  expect(failures).toEqual([]);
});

test("a page slow on both first-load attempts fails", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/explore" && hit <= 2 ? 300 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/explore") && f.why.includes("took"))).toBe(true);
});

test("a /healthz that is slow once in the watch is asked again and passes (#8917)", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/healthz" && hit === 4 ? 300 : 0)), "t", { heavy });
  expect(failures.filter((f) => f.url.endsWith("/healthz"))).toEqual([]);
});

test("a /healthz that is slow twice in a row in the watch fails", async () => {
  // hit 1 is the pre-watch check of /healthz by smoke; the watch's polls follow
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/healthz" && (hit === 4 || hit === 5) ? 300 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/healthz") && f.why.includes("took") && f.slow === true)).toBe(true);
});

test("a failure that is not slowness is not marked slow (#9238)", async () => {
  const failures = await smoke(forge(0, [], () => undefined, () => 0), "t", { heavy });
  expect(failures.every((f) => f.slow !== true)).toBe(true);
});

test("a polled heavy page that is slow once in the watch is asked again and passes", async () => {
  // hit 1 is the first load; hit 2 is the watch's poll of /explore
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/explore" && hit === 2 ? 300 : 0)), "t", { heavy });
  expect(failures).toEqual([]);
});

test("a polled heavy page that is slow twice in a row in the watch fails", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/explore" && (hit === 2 || hit === 3) ? 300 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/explore") && f.why.includes("took"))).toBe(true);
});

test("a page slow on the wall clock whose Server-Timing says the forge was quick passes (#9022)", async () => {
  // Every /explore answer arrives late, but the forge says it spent 5 ms: the delay is the road, not the release.
  const quick = (p: string) => (p === "/explore" ? new Response("page", { headers: { "server-timing": "db;dur=1.0, app;dur=5.0" } }) : undefined);
  const failures = await smoke(forge(0, [], quick, (p) => (p === "/explore" ? 300 : 0)), "t", { heavy });
  expect(failures).toEqual([]);
});

test("a page whose Server-Timing says the forge itself was slow still fails", async () => {
  const slowOwn = (p: string) => (p === "/explore" ? new Response("page", { headers: { "server-timing": "app;dur=290.0" } }) : undefined);
  const failures = await smoke(forge(0, [], slowOwn, (p) => (p === "/explore" ? 300 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/explore") && f.why.includes("took"))).toBe(true);
});

test("a hang is a failure whatever Server-Timing would have said", async () => {
  const quick = (p: string) => (p === "/explore" ? new Response("page", { headers: { "server-timing": "app;dur=5.0" } }) : undefined);
  const failures = await smoke(forge(0, [], quick, (p, hit) => (p === "/explore" && hit === 1 ? 2_000 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/explore") && f.why.includes("did not answer"))).toBe(true);
});

test("forgeMs reads the app entry of Server-Timing, and nothing when there is none", () => {
  expect(forgeMs(new Response("", { headers: { "server-timing": "db;dur=2.5, app;dur=7.6, render;dur=2.4" } }))).toBe(7.6);
  expect(forgeMs(new Response("", { headers: { "server-timing": "render;dur=2.4" } }))).toBeUndefined();
  expect(forgeMs(new Response(""))).toBeUndefined();
});

test("a hung first load is not asked again", async () => {
  const seen: string[] = [];
  const failures = await smoke(forge(0, seen, () => undefined, (p, hit) => (p === "/boards" && hit === 1 ? 2_000 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/boards") && f.why.includes("did not answer"))).toBe(true);
});

test("a /healthz that gets no answer once in the watch is asked again and passes (#7724)", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/healthz" && hit === 4 ? 1_000 : 0)), "t", { heavy });
  expect(failures.filter((f) => f.url.endsWith("/healthz"))).toEqual([]);
});

test("a /healthz that gets no answer twice in a row in the watch fails (#7724)", async () => {
  const failures = await smoke(forge(0, [], () => undefined, (p, hit) => (p === "/healthz" && (hit === 4 || hit === 5) ? 1_000 : 0)), "t", { heavy });
  expect(failures.some((f) => f.url.endsWith("/healthz") && f.why.includes("did not answer"))).toBe(true);
});
