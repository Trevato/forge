/** An unknown path that names a file answers a tiny plain 404; pages keep the full one. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-asset404-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

for (const ext of ["xml", "json", "txt", "js", "css", "map", "png", "ico"]) {
  test(`GET /nothing-here.${ext} is a one-line plain 404 with the floor`, async () => {
    const res = await fetch(`${servers.url}/nothing-here.${ext}`);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(body).toBe("not found\n");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBeTruthy();
    expect(res.headers.get("content-security-policy")).toBeTruthy();
  });
}

test("extensionless and .html unknown paths still render the full page", async () => {
  for (const path of ["/nothing-here", "/nothing-here.html"]) {
    const res = await fetch(`${servers.url}${path}`);
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(body.length).toBeGreaterThan(2000);
  }
});

test("a route that really ends in .json still matches first", async () => {
  const res = await fetch(`${servers.url}/api/v1/openapi.json`);
  expect(res.status).toBe(200);
  await res.arrayBuffer();
});

const miss = (path: string, init?: RequestInit) => fetch(`${servers.url}${path}`, init);

test("no-route branch (server.ts): deep unknown file paths are the tiny 404", async () => {
  for (const path of ["/a/b/c.png", "/a/b/c/d.xml"]) {
    const res = await miss(path);
    expect([path, res.status, await res.text()]).toEqual([path, 404, "not found\n"]);
  }
});

test("owner-page branch (notFoundPage in chrome.ts): one-segment unknown file paths are the tiny 404", async () => {
  for (const path of ["/nothing-here.png", "/nothing-here.xml"]) {
    const res = await miss(path);
    expect([path, res.status, await res.text()]).toEqual([path, 404, "not found\n"]);
  }
});

test("HEAD gets the 404 with no body", async () => {
  const res = await miss("/nothing-here.xml", { method: "HEAD" });
  expect(res.status).toBe(404);
  expect(res.headers.get("content-type")).toContain("text/plain");
  expect(await res.text()).toBe("");
});

test("a POST to a file-shaped path does not get the plain 404", async () => {
  const res = await miss("/nothing-here.xml", { method: "POST", body: "x" });
  expect(await res.text()).not.toBe("not found\n");
});

test("machine surfaces keep their own miss, not the plain text one", async () => {
  for (const path of ["/contract/x.json", "/mcp/x.txt", "/.well-known/x.json", "/api/v1/nope.json", "/api/nope.png"]) {
    const res = await miss(path);
    expect([path, res.headers.get("content-type") ?? ""]).not.toEqual([path, expect.stringContaining("text/plain")]);
    expect([path, await res.text()]).not.toEqual([path, "not found\n"]);
  }
});
