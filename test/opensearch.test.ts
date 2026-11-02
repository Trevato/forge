import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("the forge as a browser search engine", () => {
  let dataDir: string;
  let servers: Servers;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-opensearch-"));
    const app = createApp({ dataDir, port: 0, url: "https://forge.example.org" });
    servers = await serve(app);
    base = servers.url;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the description's template is the search page and the search route answers it", async () => {
    const res = await fetch(`${base}/opensearch.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/opensearchdescription+xml");
    expect(res.headers.get("cache-control")).toContain("max-age");
    const xml = await res.text();
    expect(xml).toContain("<ShortName>forge</ShortName>");
    const template = /<Url type="text\/html"[^>]*template="([^"]+)"/.exec(xml)?.[1];
    expect(template).toBe("https://forge.example.org/search?q={searchTerms}");
    const path = new URL(template!.replace("{searchTerms}", "hello")).pathname;
    const found = await fetch(`${base}${path}?q=hello`);
    expect(found.status).toBe(200);
  });

  test("the description names the JSON search too, and it answers JSON", async () => {
    const xml = await (await fetch(`${base}/opensearch.xml`)).text();
    const template = /<Url type="application\/json" method="get" template="([^"]+)"/.exec(xml)?.[1];
    expect(template).toBe("https://forge.example.org/api/v1/search?q={searchTerms}");
    const path = new URL(template!.replace("{searchTerms}", "hello")).pathname;
    const found = await fetch(`${base}${path}?q=hello`);
    expect(found.status).toBe(200);
    expect(found.headers.get("content-type")).toContain("application/json");
  });

  test("a forged Host never reaches the description", async () => {
    const res = await fetch(`${base}/opensearch.xml`, { headers: { host: "evil.example" } });
    expect(await res.text()).not.toContain("evil.example");
  });

  test("every page's head links to it", async () => {
    const page = await (await fetch(`${base}/`)).text();
    expect(page).toMatch(/<link\s+rel="search"\s+type="application\/opensearchdescription\+xml"\s+href="\/opensearch\.xml"\s+title="forge"/);
  });
});
