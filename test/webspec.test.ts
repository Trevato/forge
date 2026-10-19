import { expect, test } from "bun:test";
import { webspec } from "../src/release/webspec.ts";

const GOOD_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Home</title>
<meta name="description" content="d"><link rel="canonical" href="https://x.test/">
<meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)">
<meta name="color-scheme" content="light dark">
<meta property="og:title" content="t"><meta property="og:type" content="website"><meta property="og:url" content="https://x.test/">
<meta property="og:description" content="d"><meta property="og:image" content="https://x.test/og.png">
<link rel="icon" href="/icon.svg"><link rel="manifest" href="/m.json"></head><body>hi</body></html>`;

const GOOD_HEADERS: Record<string, string> = {
  "content-type": "text/html",
  "content-security-policy": "default-src 'self'; script-src 'self'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "permissions-policy": "camera=()",
  "strict-transport-security": "max-age=63072000",
  "cache-control": "no-cache",
  etag: '"v1"',
};

function site(html = GOOD_HTML, headers: Record<string, string> = GOOD_HEADERS, extra: Record<string, number> = {}) {
  return async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    if (u.pathname in extra) return new Response("x", { status: extra[u.pathname]! });
    if (u.pathname === "/icon.svg" || u.pathname === "/m.json") return new Response("x");
    const h = new Headers(init?.headers);
    if (h.get("if-none-match") && headers["etag"] === h.get("if-none-match")) return new Response(null, { status: 304 });
    return new Response(html, { headers });
  };
}

const checks = async (html?: string, headers?: Record<string, string>, extra?: Record<string, number>) =>
  (await webspec("https://x.test", ["/"], site(html, headers, extra))).map((f) => f.check);
const without = (k: string) => Object.fromEntries(Object.entries(GOOD_HEADERS).filter(([n]) => n !== k));

test("a page meeting every check has no findings", async () => {
  expect(await webspec("https://x.test", ["/"], site())).toEqual([]);
});

test("each head check yields exactly its finding", async () => {
  const cases: [string, string, string][] = [
    ["doctype", GOOD_HTML.replace("<!doctype html>", ""), "doctype"],
    ["lang", GOOD_HTML.replace(' lang="en"', ""), "lang"],
    ["charset", GOOD_HTML.replace('<meta charset="utf-8">', ""), "charset"],
    ["zoom", GOOD_HTML.replace("initial-scale=1", "maximum-scale=1"), "viewport"],
    ["user-scalable", GOOD_HTML.replace("initial-scale=1", "user-scalable=no"), "viewport"],
    ["two titles", GOOD_HTML.replace("</head>", "<title>b</title></head>"), "title"],
    ["no title", GOOD_HTML.replace("<title>Home</title>", ""), "title"],
    ["description", GOOD_HTML.replace('<meta name="description" content="d">', ""), "description"],
    ["canonical missing", GOOD_HTML.replace(/<link rel="canonical"[^>]*>/, ""), "canonical"],
    ["canonical differs", GOOD_HTML.replace('canonical" href="https://x.test/"', 'canonical" href="https://x.test/a"'), "canonical"],
    ["dark theme", GOOD_HTML.replace(/<meta name="theme-color" content="#000"[^>]*>/, ""), "theme-color"],
    ["color-scheme", GOOD_HTML.replace('<meta name="color-scheme" content="light dark">', ""), "color-scheme"],
    ["og:image", GOOD_HTML.replace(/<meta property="og:image"[^>]*>/, ""), "open-graph"],
  ];
  for (const [name, html, check] of cases) expect([name, await checks(html)]).toEqual([name, [check]]);
});

test("icons and the manifest must resolve", async () => {
  expect(await checks(undefined, undefined, { "/icon.svg": 404 })).toEqual(["head-links"]);
  expect(await checks(undefined, undefined, { "/m.json": 500 })).toEqual(["head-links"]);
});

test("each header check yields exactly its finding", async () => {
  const h = (k: string, v: string) => ({ ...GOOD_HEADERS, [k]: v });
  const cases: [string, Record<string, string>, string][] = [
    ["csp missing", without("content-security-policy"), "csp"],
    ["unsafe-eval", h("content-security-policy", "script-src 'self' 'unsafe-eval'; frame-ancestors 'none'"), "csp"],
    ["unsafe-inline script", h("content-security-policy", "script-src 'self' 'unsafe-inline'; frame-ancestors 'none'"), "csp"],
    ["frame-ancestors", h("content-security-policy", "script-src 'self'"), "frame-ancestors"],
    ["nosniff", without("x-content-type-options"), "nosniff"],
    ["referrer", without("referrer-policy"), "referrer-policy"],
    ["permissions", without("permissions-policy"), "permissions-policy"],
    ["xss", h("x-xss-protection", "1"), "x-xss-protection"],
    ["immutable html", h("cache-control", "public, max-age=1, immutable"), "cache-html"],
    ["etag", without("etag"), "etag"],
  ];
  for (const [name, headers, check] of cases) expect([name, await checks(undefined, headers)]).toEqual([name, [check]]);
});

test("style-src unsafe-inline is not a script finding", async () => {
  const csp = "script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
  expect(await checks(undefined, { ...GOOD_HEADERS, "content-security-policy": csp })).toEqual([]);
});

test("HSTS is an edge finding on https only", async () => {
  const found = await webspec("https://x.test", ["/"], site(GOOD_HTML, without("strict-transport-security")));
  expect(found.map((f) => [f.check, f.edge])).toEqual([["hsts", true]]);
  expect(await webspec("http://x.test", ["/"], site(GOOD_HTML, without("strict-transport-security")))).toEqual([]);
});

test("an ETag that does not answer 304 is a finding", async () => {
  const f = async (input: string) =>
    input.endsWith(".svg") || input.endsWith(".json") ? new Response("x") : new Response(GOOD_HTML, { headers: GOOD_HEADERS });
  const found = await webspec("https://x.test", ["/"], f);
  expect(found.map((x) => x.check)).toEqual(["etag"]);
});

test("findings are plain data citing a section; failures to fetch are findings", async () => {
  const [f] = await webspec("https://x.test", ["/a"], site(GOOD_HTML.replace(' lang="en"', "")));
  expect(f).toEqual({ path: "/a", check: "lang", message: expect.any(String), section: "https://specification.website/#lang" });
  const down = await webspec("https://x.test", ["/"], async () => {
    throw new Error("boom");
  });
  expect(down.map((x) => x.check)).toEqual(["fetch"]);
});

test("a page that does not answer 2xx is a fetch finding", async () => {
  const f = async () => new Response("nope", { status: 500 });
  const found = await webspec("https://x.test", ["/"], f);
  expect(found.map((x) => x.check)).toEqual(["fetch"]);
});

test("default-src 'unsafe-inline' counts when there is no script-src", async () => {
  const csp = "default-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
  expect(await checks(undefined, { ...GOOD_HEADERS, "content-security-policy": csp })).toEqual(["csp"]);
});

test("the http-equiv charset form is accepted", async () => {
  const html = GOOD_HTML.replace('<meta charset="utf-8">', '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">');
  expect(await checks(html)).toEqual([]);
});

test("apple-touch-icon must resolve, and an invalid href is a finding", async () => {
  const html = GOOD_HTML.replace("</head>", '<link rel="apple-touch-icon" href="/touch.png"></head>');
  expect(await checks(html, undefined, { "/touch.png": 404 })).toEqual(["head-links"]);
  expect(await checks(html, undefined, { "/touch.png": 200 })).toEqual([]);
  const bad = GOOD_HTML.replace("</head>", '<link rel="icon" href="http://[bad"></head>');
  expect(await checks(bad)).toEqual(["head-links"]);
});

test("every fetch carries a timeout signal", async () => {
  const seen: boolean[] = [];
  const inner = site();
  await webspec("https://x.test", ["/"], async (u, init) => {
    seen.push(init?.signal instanceof AbortSignal);
    return inner(u, init);
  });
  expect(seen.length).toBeGreaterThan(3);
  expect(seen.every(Boolean)).toBe(true);
});

test("compression: a big page and stylesheet must leave encoded with Vary", async () => {
  const big = GOOD_HTML.replace("</head>", `<link rel="stylesheet" href="/a.css"></head>`).replace(">hi<", `>${"x".repeat(2000)}<`);
  const fetcher = (encoded: boolean) => async (input: string, init?: RequestInit) => {
    const u = new URL(input);
    const h = new Headers(init?.headers);
    if (u.pathname === "/icon.svg" || u.pathname === "/m.json") return new Response("x");
    if (h.get("if-none-match")) return new Response(null, { status: 304 });
    expect(h.get("accept-encoding")).toBe("br, gzip");
    const enc: Record<string, string> = encoded ? { "content-encoding": "br", vary: "Accept-Encoding" } : {};
    if (u.pathname === "/a.css") return new Response("a{}".repeat(500), { headers: enc });
    return new Response(big, { headers: { ...GOOD_HEADERS, ...enc } });
  };
  expect(await webspec("https://x.test", ["/"], fetcher(true))).toEqual([]);
  const found = await webspec("https://x.test", ["/"], fetcher(false));
  expect(found.map((f) => f.check)).toEqual(["compression", "compression"]);
  expect(found[1]!.message).toContain("/a.css");
  expect(found[0]!.section).toBe("https://specification.website/");
});
