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

test("the front page names the forge once", async () => {
  const raw = await page("/");
  const title = /<title>([^<]*)<\/title>/.exec(raw)?.[1] ?? "";
  expect(title).toStartWith("Open Platform Forge: ");
  expect(title.match(/forge/gi)).toHaveLength(1);
  expect(raw).toContain(`property="og:title" content="${title}"`);
});

test("another page keeps its suffix", async () => {
  expect(await page("/login")).toMatch(/<title>[^<]+ · forge<\/title>/);
});

test("no title ends in the suffix twice", async () => {
  const { tabTitle } = await import("../src/web/layout.ts");
  expect(tabTitle("Search · forge")).toBe("Search · forge");
  expect(tabTitle("Issues · forge · forge")).toBe("Issues · forge");
  expect(tabTitle("forge")).toBe("forge");
  // A title that opens with the forge's name names it already.
  expect(tabTitle("forge: software for what you're building")).toBe("forge: software for what you're building");
  expect(tabTitle("forge-x")).toBe("forge-x · forge");
  expect(tabTitle("Open Platform Forge: pricing")).toBe("Open Platform Forge: pricing");
  for (const path of ["/search?q=forge", "/trevato/forge/issues", "/trevato/forge/pulls"])
    expect(await page(path)).not.toContain("· forge · forge");
});
