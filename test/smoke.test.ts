import { afterEach, expect, test } from "bun:test";
import { isSignInRedirect, smoke, stylesheetHref } from "../scripts/smoke.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

const GOOD_SW = `self.addEventListener('fetch', function (e) {
  if (e.request.mode === 'navigate') {
    // never Response.error()
    e.respondWith(fetch(e.request).catch(offline));
    return;
  }
  e.respondWith(fetch(e.request).catch(function () { return Response.error(); }));
});`;
const BAD_SW = GOOD_SW.replace("catch(offline)", "catch(function () { return Response.error(); })");
let sw: { body: string; type: string; status: number } = { body: GOOD_SW, type: "text/javascript", status: 200 };
let version = () => "v1";
let anonymousBoard = { status: 302, location: "/signin" };

function stub(cssType: string, seen: string[] = []) {
  sw = { body: GOOD_SW, type: "text/javascript", status: 200 };
  version = () => "v1";
  anonymousBoard = { status: 302, location: "/signin" };
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push(`${path} ${req.headers.get("user-agent")}`);
      if (path === "/") return new Response('<link rel="stylesheet" href="/a/app.css">', { headers: { "content-type": "text/html" } });
      if (path === "/a/app.css") return new Response("body{margin:0}", { headers: { "content-type": cssType } });
      if (path === "/board")
        return req.headers.get("authorization") === "Bearer t"
          ? new Response("board")
          : new Response(null, { status: anonymousBoard.status, headers: { location: anonymousBoard.location } });
      if (path === "/healthz") return new Response("ok", { headers: { "x-forge-version": version() } });
      if (["/explore", "/search", "/boards"].includes(path) || path.startsWith("/trevato/")) return new Response("page");
      if (path === "/sw.js") return new Response(sw.body, { status: sw.status, headers: { "content-type": sw.type } });
      return new Response("no", { status: 404 });
    },
  });
  return `http://127.0.0.1:${server.port}`;
}

test("a good stub passes, each request as phone and desktop", async () => {
  const seen: string[] = [];
  expect(await smoke(stub("text/css; charset=utf-8", seen), "t")).toEqual([]);
  expect(seen.filter((s) => s.startsWith("/healthz ")).length).toBe(2);
  expect(seen.some((s) => s.includes("iPhone"))).toBe(true);
  expect(seen.some((s) => s.includes("Chrome"))).toBe(true);
});

test("a stylesheet served as text/html fails, naming url, agent, status and type", async () => {
  const failures = await smoke(stub("text/html"), "t");
  expect(failures.length).toBe(2);
  expect(failures[0]).toMatchObject({ status: 200, contentType: "text/html", agent: "phone" });
  expect(failures[0]!.url).toEndWith("/a/app.css");
});

test("/board without a token is a 302 and fails", async () => {
  const failures = await smoke(stub("text/css"), "");
  expect(failures.map((f) => f.status)).toEqual([302, 302]);
});

test("the CLI exits non-zero on failure and zero on success", async () => {
  const run = async (url: string) =>
    (await Bun.spawn(["bun", "scripts/smoke.ts", url], { env: { ...process.env, FORGE_TOKEN: "t" }, stdout: "pipe", stderr: "pipe" }).exited);
  expect(await run(stub("text/css"))).toBe(0);
  server?.stop(true);
  expect(await run(stub("text/html"))).toBe(1);
});

test("stylesheetHref finds the link", () => {
  expect(stylesheetHref('<link rel="icon" href="/x"><link rel="stylesheet" href="/s.css">')).toBe("/s.css");
  expect(stylesheetHref("<p>none</p>")).toBeNull();
});

test("--version waits for a late version", async () => {
  const base = stub("text/css", []);
  let polls = 0;
  version = () => (++polls < 3 ? "old" : "v2");
  expect(await smoke(base, "t", { version: "v2", waitMs: 5000, pollMs: 10 })).toEqual([]);
  expect(polls).toBeGreaterThanOrEqual(3);
});

test("a version that never arrives fails naming the last one seen", async () => {
  const base = stub("text/css");
  const failures = await smoke(base, "t", { version: "v9", waitMs: 100, pollMs: 10 });
  expect(failures.length).toBe(1);
  expect(failures[0]!.why).toContain("v9");
  expect(failures[0]!.why).toContain("last saw v1");
});

test("a Response.error() on a navigation, a non-JS or a missing sw.js fails", async () => {
  const base = stub("text/css");
  sw.body = BAD_SW;
  expect((await smoke(base, "t")).map((f) => f.why)).toEqual([expect.stringContaining("Response.error()")]);
  sw = { body: GOOD_SW, type: "text/html", status: 200 };
  expect((await smoke(base, "t")).map((f) => f.why)).toEqual(["expected javascript"]);
  sw = { body: "", type: "text/javascript", status: 404 };
  expect((await smoke(base, "t")).map((f) => f.why)).toEqual(["expected 200"]);
});

test("the CLI takes --version and --wait", async () => {
  const base = stub("text/css");
  const run = (...a: string[]) =>
    Bun.spawn(["bun", "scripts/smoke.ts", base, ...a], { env: { ...process.env, FORGE_TOKEN: "t" }, stdout: "pipe", stderr: "pipe" }).exited;
  expect(await run("--version", "v1", "--watch", "0.2")).toBe(0);
  expect(await run("--version", "zz", "--wait", "0")).toBe(1);
});

test("anonymousBoard: a 302 from /board passes with no token, and only then", async () => {
  const base = stub("text/css");
  expect(await smoke(base, "", { anonymousBoard: true })).toEqual([]);
  expect((await smoke(base, "", {})).map((f) => f.status)).toEqual([302, 302]);
  expect((await smoke(base, "wrong", { anonymousBoard: true })).map((f) => f.status)).toEqual([302, 302]);
});

test("anonymousBoard: a 302, 303 or 307 to the forge's or the edge's sign-in is sign-in (#2673)", async () => {
  const base = stub("text/css");
  for (const [status, location] of [
    [302, "/signin?next=%2Fboard"],
    [303, "/signin?next=%2Fboard"],
    [303, `${base}/_plat/login?rd=%2Fboard`],
    [307, "/_plat/login?rd=%2Fboard"],
  ] as const) {
    anonymousBoard = { status, location };
    expect(await smoke(base, "", { anonymousBoard: true })).toEqual([]);
  }
});

test("anonymousBoard: a 303 anywhere but sign-in is still a failure", async () => {
  const base = stub("text/css");
  for (const location of ["/elsewhere", "https://evil.example/signin", "/signin/parent"]) {
    anonymousBoard = { status: 303, location };
    const failures = await smoke(base, "", { anonymousBoard: true });
    expect(failures.map((f) => f.status)).toEqual([303, 303]);
    expect(failures[0]!.why).toBe("expected 200 (or a redirect to sign-in)");
  }
  anonymousBoard = { status: 301, location: "/signin" };
  expect((await smoke(base, "", { anonymousBoard: true })).map((f) => f.status)).toEqual([301, 301]);
});

test("isSignInRedirect wants a redirect status and a same-origin sign-in Location", () => {
  const at = "https://forge.example/board";
  const res = (status: number, location?: string) =>
    new Response(null, { status, headers: location === undefined ? {} : { location } });
  expect(isSignInRedirect(at, res(303, "https://forge.example/_plat/login?rd=%2Fboard"))).toBe(true);
  expect(isSignInRedirect(at, res(302, "/signin"))).toBe(true);
  expect(isSignInRedirect(at, res(303))).toBe(false);
  expect(isSignInRedirect(at, res(303, "https://other.example/_plat/login"))).toBe(false);
  expect(isSignInRedirect(at, res(200, "/signin"))).toBe(false);
});

test("--outsider without FORGE_TOKEN exits 2 and prints no ok", async () => {
  const base = stub("text/css");
  const env = { ...process.env };
  delete env["FORGE_TOKEN"];
  const proc = Bun.spawn(["bun", "scripts/smoke.ts", base, "--outsider"], { env, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(2);
  expect(await new Response(proc.stdout).text()).not.toContain("ok");
  expect(await new Response(proc.stderr).text()).toContain("FORGE_TOKEN");
});

test("navigationBranch finds the real service worker's navigate branch, free of Response.error()", async () => {
  const { swSource } = await import("../src/web/sw.ts");
  const { navigationBranch } = await import("../src/release/smoke.ts");
  const nav = navigationBranch(swSource);
  expect(nav).not.toBeNull();
  expect(nav).toContain("navigate");
  expect(nav).not.toMatch(/Response\s*\.\s*error\s*\(/);
});

test("navigationBranch gives null without a navigate mode", async () => {
  const { navigationBranch } = await import("../src/release/smoke.ts");
  expect(navigationBranch("self.addEventListener('fetch', function (e) { e.respondWith(fetch(e.request)); });")).toBeNull();
});

test("navigationBranch counts Response.error() inside the branch only, not in comments or after return", async () => {
  const { navigationBranch } = await import("../src/release/smoke.ts");
  const error = /Response\s*\.\s*error\s*\(/;
  const wrap = (body: string) => `if (e.request.mode === 'navigate') {\n${body}\n return;\n}\nreturn Response.error();`;
  expect(navigationBranch(wrap("// Response.error()\n respond();"))).not.toMatch(error);
  expect(navigationBranch(wrap("/* Response.error() */ respond();"))).not.toMatch(error);
  expect(navigationBranch(wrap("respond(Response.error());"))).toMatch(error);
  expect(navigationBranch(wrap("respond();"))).not.toMatch(error);
});

test("--app-host fails when an app host answers with the forge's page", async () => {
  const forgePage = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>forge</title>", { headers: { "content-type": "text/html" } }) });
  const appPage = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<title>notes</title>") });
  try {
    const base = stub("text/css");
    expect(await smoke(base, "t", { appHost: `http://127.0.0.1:${appPage.port}` })).toEqual([]);
    const failures = await smoke(base, "t", { appHost: `http://127.0.0.1:${forgePage.port}` });
    expect(failures.map((f) => f.why)).toEqual(["an app host answered with the forge's page"]);
  } finally {
    forgePage.stop(true);
    appPage.stop(true);
  }
});

test("an app host that gives no answer is asked again, then left out of the release verdict (#10189)", async () => {
  const base = stub("text/css");
  const timeout = () => Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
  const make = (fails: number, body = "<title>notes</title>") => {
    let hostCalls = 0;
    const f = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).startsWith("http://app.invalid")) {
        if (++hostCalls <= fails) throw timeout();
        return new Response(body);
      }
      return fetch(input, init);
    }) as unknown as typeof fetch;
    return { f, calls: () => hostCalls };
  };
  const once = make(1, "<title>forge</title>");
  // A wake-up timeout is asked again, and the second answer is still judged.
  expect((await smoke(base, "t", { appHost: "http://app.invalid/", fetch: once.f })).map((f) => f.why)).toEqual(["an app host answered with the forge's page"]);
  expect(once.calls()).toBe(2);
  const silent = make(99);
  expect(await smoke(base, "t", { appHost: "http://app.invalid/", fetch: silent.f })).toEqual([]);
  expect(silent.calls()).toBe(2);
});
