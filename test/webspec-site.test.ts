import { expect, test } from "bun:test";
import { webspec } from "../src/release/webspec.ts";
import { SITEMAP_CAP } from "../src/release/webspec-site.ts";

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found</title><link rel="stylesheet" href="/a.css"><link rel="manifest" href="/m.json"></head><body>x</body></html>`;
const html = { "content-type": "text/html" };
const future = new Date(Date.now() + 86400e3 * 100).toISOString();

type Route = Response;
function good(): Record<string, Route> {
  return {
    "/": new Response(PAGE, { headers: html }),
    "/robots.txt": new Response("User-agent: *\nSitemap: https://x.test/sitemap.xml\n"),
    "/sitemap.xml": new Response("<urlset><url><loc>https://x.test/</loc></url><url><loc>https://x.test/a</loc></url></urlset>"),
    "/a": new Response("ok"),
    "/.well-known/security.txt": new Response(`Contact: mailto:a@x.test\nExpires: ${future}\n`),
    "/m.json": new Response(JSON.stringify({ name: "X", icons: [{ src: "/i.png" }] })),
    "/llms.txt": new Response("# X"),
    "/.well-known/change-password": new Response(null, { status: 302, headers: { location: "/account" } }),
  };
}

const run = async (over: Record<string, Route | null> = {}, errorPath?: string) => {
  const routes: Record<string, Route | null> = { ...good(), ...over };
  const f = async (input: string): Promise<Response> => {
    const p = new URL(input).pathname;
    const r = p in routes ? routes[p] : p.startsWith("/__webspec-") ? new Response(PAGE, { status: 404, headers: html }) : undefined;
    if (r === undefined || r === null) return new Response("nope", { status: 404 });
    return r.clone() as Response;
  };
  return (await webspec("https://x.test", [], f, { site: true, ...(errorPath ? { errorPath } : {}) })).map((x) => x.check);
};

test("a site meeting checks 3 and 4 has no findings, and every finding cites a section", async () => {
  expect(await run()).toEqual([]);
  const bad = await webspec("https://x.test", [], async () => new Response("no", { status: 500 }), { site: true });
  expect(bad.length).toBeGreaterThan(0);
  expect(bad.every((f) => f.section.startsWith("https://specification.website/#"))).toBe(true);
});

test("without opts.site nothing extra is fetched", async () => {
  let n = 0;
  await webspec("https://x.test", [], async () => (n++, new Response("")));
  expect(n).toBe(0);
});

test("robots.txt must answer and name a sitemap", async () => {
  expect(await run({ "/robots.txt": null })).toEqual(["robots"]);
  expect(await run({ "/robots.txt": new Response("User-agent: *\n") })).toEqual(["robots"]);
});

test("the sitemap must answer and list no URL a stranger is refused", async () => {
  const map = (loc: string) => new Response(`<urlset><url><loc>${loc}</loc></url></urlset>`);
  expect(await run({ "/sitemap.xml": null })).toEqual(["sitemap"]);
  expect(await run({ "/sitemap.xml": map("https://x.test/a"), "/a": new Response("", { status: 403 }) })).toEqual(["sitemap"]);
  expect(await run({ "/sitemap.xml": map("https://x.test/a"), "/a": new Response("", { status: 401 }) })).toEqual(["sitemap"]);
  expect(await run({ "/sitemap.xml": map("https://x.test/a"), "/a": new Response("", { status: 302, headers: { location: "/sign-in?next=/a" } }) })).toEqual(["sitemap"]);
  expect(await run({ "/sitemap.xml": map("https://x.test/a"), "/a": new Response("", { status: 301, headers: { location: "/b" } }) })).toEqual([]);
  expect(await run({ "/sitemap.xml": map("https://x.test/a"), "/a": new Response("", { status: 301, headers: { location: "/authors" } }) })).toEqual([]);
});

test("the sitemap walk is capped and stays on the site", async () => {
  const locs = Array.from({ length: SITEMAP_CAP + 30 }, (_, i) => `<url><loc>https://x.test/p${i}</loc></url>`).join("") + "<url><loc>https://evil.test/z</loc></url>";
  const seen: string[] = [];
  const f = async (input: string) => {
    const u = new URL(input);
    seen.push(u.href);
    if (u.pathname === "/robots.txt") return new Response("Sitemap: https://x.test/sitemap.xml");
    if (u.pathname === "/sitemap.xml") return new Response(`<urlset>${locs}</urlset>`);
    return new Response("", { status: 404 });
  };
  await webspec("https://x.test", [], f, { site: true });
  expect(seen.filter((u) => /\/p\d+$/.test(u)).length).toBe(SITEMAP_CAP);
  expect(seen.some((u) => u.includes("evil.test"))).toBe(false);
});

test("security.txt must answer with an Expires in the future", async () => {
  expect(await run({ "/.well-known/security.txt": null })).toEqual(["security-txt"]);
  expect(await run({ "/.well-known/security.txt": new Response("Contact: a") })).toEqual(["security-txt"]);
  expect(await run({ "/.well-known/security.txt": new Response("Expires: 2001-01-01T00:00:00Z") })).toEqual(["security-txt"]);
});

test("the manifest must parse and carry name and icons", async () => {
  expect(await run({ "/m.json": null })).toEqual(["manifest"]);
  expect(await run({ "/m.json": new Response("{nope") })).toEqual(["manifest"]);
  expect(await run({ "/m.json": new Response(JSON.stringify({ icons: [{}] })) })).toEqual(["manifest"]);
  expect(await run({ "/m.json": new Response(JSON.stringify({ name: "X", icons: [] })) })).toEqual(["manifest"]);
});

test("llms.txt must answer and change-password must redirect", async () => {
  expect(await run({ "/llms.txt": null })).toEqual(["llms-txt"]);
  expect(await run({ "/.well-known/change-password": new Response("hi") })).toEqual(["change-password"]);
  expect(await run({ "/.well-known/change-password": null })).toEqual(["change-password"]);
});

test("the random path must answer 404 with the app's own page", async () => {
  const withRandom = async (res: Response) => {
    const g: Record<string, Route> = good();
    const f = async (input: string): Promise<Response> => {
      const p = new URL(input).pathname;
      if (p.startsWith("/__webspec-")) return res.clone() as Response;
      return g[p] ? (g[p]!.clone() as Response) : new Response("", { status: 404 });
    };
    return (await webspec("https://x.test", [], f, { site: true })).map((x) => x.check);
  };
  expect(await withRandom(new Response("Not found", { status: 404 }))).toEqual(["error-404"]);
  expect(await withRandom(new Response(PAGE, { status: 200, headers: html }))).toEqual(["error-404"]);
  expect(await withRandom(new Response(PAGE.replace(/<title>.*<\/title>/, ""), { status: 404, headers: html }))).toEqual(["error-404"]);
});

test("a 500 is checked only when a path is named, and must be the custom page", async () => {
  const over = (r: Response) => ({ "/boom": r });
  expect(await run(over(new Response("x", { status: 200 })))).toEqual([]);
  expect(await run(over(new Response(PAGE, { status: 500, headers: html })), "/boom")).toEqual([]);
  expect(await run(over(new Response(PAGE, { status: 200, headers: html })), "/boom")).toEqual(["error-500"]);
  expect(await run(over(new Response("Internal", { status: 500 })), "/boom")).toEqual(["error-500"]);
});
