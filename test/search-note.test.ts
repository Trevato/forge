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

const raw = (qs: string) => fetch(`${servers.url}/api/v1/search${qs}`);

test("an unknown or empty kind is a 422 invalid_kind listing the kinds", async () => {
  for (const kind of ["bogus", ""]) {
    const res = await raw(`?q=forge&kind=${kind}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_kind");
    expect(body.message).toContain("all, repos, issues or code");
  }
});

test("a limit outside 1 to 100 or not whole is a 422 invalid_limit naming the range", async () => {
  for (const limit of ["0", "101", "-1", "1.5", "abc", "", "1e1"]) {
    const res = await raw(`?q=forge&limit=${limit}`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    expect(body.error).toBe("invalid_limit");
    expect(body.message).toContain("1 to 100");
  }
  expect((await raw("?q=forge&limit=100")).status).toBe(200);
  expect((await raw("?q=forge&limit=1")).status).toBe(200);
});

test("every listed kind still answers 200", async () => {
  for (const kind of ["all", "repos", "issues", "code"]) expect((await raw(`?q=forge&kind=${kind}`)).status).toBe(200);
});

test("a good request carries no note", async () => {
  expect((await get("?q=forge&kind=repos")).note).toBeUndefined();
  expect((await get("?q=forge&kind=all")).note).toBeUndefined();
  expect(searchNote("x")).toBeUndefined();
});
