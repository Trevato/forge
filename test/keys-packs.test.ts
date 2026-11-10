/** The packs list joins the shell's j/k row traversal (#10404): one data-nav per linked row. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { catalog } from "../src/packs/catalog.ts";
import { packsList } from "../src/web/pages/packs.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-keys-packs-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const navRows = (text: string) => text.split("<li").filter((li) => /class="row"[^>]*data-nav tabindex="-1"/.test(li));

test("each pack on /packs is one data-nav row whose first link opens the pack", async () => {
  const { packs } = catalog();
  expect(packs.length).toBeGreaterThan(0);
  const rows = navRows(await (await fetch(`${servers.url}/packs`)).text());
  expect(rows.length).toBe(packs.length);
  for (const [i, p] of packs.entries()) {
    expect(rows[i]!.match(/<a href="([^"]+)"/)![1]).toBe(`/packs/${p.name}`);
  }
});

test("a pack's own page keeps its rows out of the traversal", async () => {
  const name = catalog().packs[0]!.name;
  const text = await (await fetch(`${servers.url}/packs/${name}`)).text();
  expect(navRows(text).length).toBe(0);
});

test("an empty catalog draws no data-nav row", () => {
  const text = String(packsList([]));
  expect(text).not.toMatch(/class="row"[^>]*data-nav tabindex="-1"/);
});
