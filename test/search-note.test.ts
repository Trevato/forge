/** A search asked wrongly says how to ask it right, over HTTP, as explore does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { searchNote } from "../src/core/search.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-search-note-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (qs: string) => (await fetch(`${servers.url}/api/v1/search${qs}`)).json() as Promise<any>;

test("a missing or blank q answers the empty shape plus a note with an example and the kinds", async () => {
  for (const qs of ["", "?q=", "?q=%20%20"]) {
    const r = await get(qs);
    expect(r.repos).toEqual([]);
    expect(r.note).toContain("q is empty");
    expect(r.note).toContain("q=parser");
    expect(r.note).toContain("kind=all|repos|issues|code");
  }
});

test("an unknown kind is named in the note", async () => {
  const r = await get("?q=forge&kind=bogus");
  expect(r.note).toContain('"bogus"');
  expect(r.note).toContain("kind=all|repos|issues|code");
});

test("an empty kind is not a kind either", async () => {
  expect((await get("?q=forge&kind=")).note).toContain("is not a kind");
});

test("a good request carries no note", async () => {
  expect((await get("?q=forge&kind=repos")).note).toBeUndefined();
  expect((await get("?q=forge&kind=all")).note).toBeUndefined();
  expect(searchNote("x", null)).toBeUndefined();
});
