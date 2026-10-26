/** The tab title names the forge once (#6037). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-title-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const page = async (path: string) => (await fetch(`${servers.url}${path}`)).text();

test("the front page is titled forge, once", async () => {
  const raw = await page("/");
  expect(raw).toContain("<title>forge</title>");
  expect(raw).toContain('property="og:title" content="forge"');
});

test("another page keeps its suffix", async () => {
  expect(await page("/login")).toMatch(/<title>[^<]+ · forge<\/title>/);
});
