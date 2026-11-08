/**
 * /agents is /llms.txt as a page, for an assistant whose reader takes only
 * HTML: the same words from the same source, each address a link, and the
 * home page's prompt and Open-in links point at it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { linkAddresses } from "../src/web/pages/agents.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-agents-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  await servers.stop?.();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the page is HTML carrying every section of llms.txt, and links back to it", async () => {
  const res = await fetch(`${servers.url}/agents`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toStartWith("text/html");
  const page = await res.text();
  const plain = await (await fetch(`${servers.url}/llms.txt`)).text();
  for (const heading of plain.match(/^## .+$/gm) ?? []) expect(page).toContain(`<h2>${heading.slice(3)}</h2>`);
  expect(page).toContain('href="/llms.txt"');
  expect(page).toContain(`<a href="${servers.url}/mcp"`);
  expect(page).toContain("<title>For AI assistants · forge</title>");
});

test("an address becomes a link; code and templates stay as written", () => {
  expect(linkAddresses("See https://a.example/x.")).toBe("See [https://a.example/x](https://a.example/x).");
  expect(linkAddresses("run `curl https://a.example/x`")).toBe("run `curl https://a.example/x`");
  expect(linkAddresses("at https://a.example/{owner}/{name}")).toBe("at https://a.example/{owner}/{name}");
});

test("the home page's prompt and Open-in links point at the page", async () => {
  const home = await (await fetch(`${servers.url}/`)).text();
  expect(home).toContain(`Read ${servers.url}/agents and tell me`);
  expect(home).toContain(encodeURIComponent(`${servers.url}/agents`));
  expect(home).not.toContain("llms.txt%20and");
});

test("a placeholder address is not a link", () => {
  expect(linkAddresses('"page": "https://..."')).toBe('"page": "https://..."');
});
