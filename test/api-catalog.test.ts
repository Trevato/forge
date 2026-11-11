/** /.well-known/api-catalog (RFC 9727): one linkset, every href real. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { DISCOVERY } from "../src/core/mcp_card.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let base: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-catalog-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  base = servers.url;
});
afterAll(async () => {
  await servers.stop?.();
  await rm(dataDir, { recursive: true, force: true });
});

test("the catalog is a cacheable linkset naming each API", async () => {
  const res = await fetch(`${base}/.well-known/api-catalog`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("application/linkset+json");
  expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  const { linkset } = (await res.json()) as { linkset: Record<string, unknown>[] };
  expect(linkset.length).toBe(2);
  const anchors = linkset.map((l) => new URL(String(l["anchor"])).pathname);
  expect(anchors).toEqual(["/api/v1", "/mcp"]);
  const descs = linkset.map((l) => new URL((l["service-desc"] as { href: string }[])[0]!.href).pathname);
  expect(descs).toEqual(["/contract/openapi.json", "/.well-known/mcp.json"]);
});

test("every href in it answers 200 without a redirect", async () => {
  const { linkset } = (await (await fetch(`${base}/.well-known/api-catalog`)).json()) as {
    linkset: Record<string, { href: string }[] | string>[];
  };
  const hrefs = new Set<string>();
  for (const l of linkset)
    for (const [k, v] of Object.entries(l)) if (k !== "anchor") for (const h of v as { href: string }[]) hrefs.add(h.href);
  expect(hrefs.size).toBeGreaterThanOrEqual(3);
  for (const href of hrefs) {
    const r = await fetch(new URL(new URL(href).pathname, base), { redirect: "manual" });
    expect(r.status).toBe(200);
  }
});

test("home points at the catalog and /llms.txt lists it", async () => {
  const home = await fetch(`${base}/`);
  expect(home.headers.get("link") ?? "").toContain('</.well-known/api-catalog>; rel="api-catalog"');
  const llms = await (await fetch(`${base}/llms.txt`)).text();
  expect(llms).toContain("/.well-known/api-catalog");
  // Every discovery path but its own is named in /llms.txt, from the same constants.
  for (const [name, path] of Object.entries(DISCOVERY)) if (name !== "docs") expect(llms).toContain(path);
});
