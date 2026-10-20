import { afterAll, expect, test } from "bun:test";
import { axe, noScript, noScriptProblems } from "../src/release/axe.ts";
import { findChromium } from "../src/looks/capture.ts";

const PAGES: Record<string, string> = {
  "/": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>t</title></head><body><main><h1>Hi</h1><input type="text"></main></body></html>`,
  "/script": `<!doctype html><html lang="en"><head><title>t</title></head><body><main></main><script>document.querySelector("main").innerHTML="<h1>Hi</h1>"</script></body></html>`,
  "/good": `<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><p>text</p></main></body></html>`,
};
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (req) => {
    const html = PAGES[new URL(req.url).pathname];
    return html ? new Response(html, { headers: { "content-type": "text/html" } }) : new Response("no", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

test("a page that fills <main> from a script is a no-js finding; a rendered one is not", async () => {
  const found = await noScript(base, ["/script", "/good"]);
  expect(found.map((f) => [f.path, f.check])).toEqual([["/script", "no-js"], ["/script", "no-js"]]);
  expect(found[0]!.section).toContain("specification.website");
});

test("noScriptProblems names a missing main and heading", () => {
  expect(noScriptProblems("<body>x</body>")).toEqual(["the page has no <main>", "no main heading (<h1>) without JavaScript"]);
});

const noChromium = findChromium() === undefined;

test.skipIf(noChromium)("in a real browser: an unlabelled input yields one axe:label finding in each scheme, and a script-filled <main> a no-js finding", async () => {
  const all = await axe(base, ["/", "/script"]);
  // A browser that fails to start, a step that times out or axe throwing is a red test, not a skip.
  expect(all.filter((f) => f.check === "axe")).toEqual([]);
  const found = all.filter((f) => f.check === "axe:label" && f.path === "/");
  expect(found.map((f) => /light|dark/.exec(f.message)![0]).sort()).toEqual(["dark", "light"]);
  expect(found[0]!.section).toContain("#accessibility");
  expect(all.filter((f) => f.check === "no-js").map((f) => f.path)).toEqual(["/script", "/script"]);
}, 90000);

test.skipIf(!noChromium)("no chromium on this machine: the browser test (axe:label per scheme, no-js render) did not run", () => {});
