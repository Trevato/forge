import { afterEach, expect, test } from "bun:test";
import { smoke, stylesheetHref } from "../scripts/smoke.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => server?.stop(true));

function stub(cssType: string, seen: string[] = []) {
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
          : new Response(null, { status: 302, headers: { location: "/signin" } });
      if (path === "/healthz") return new Response("ok");
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
