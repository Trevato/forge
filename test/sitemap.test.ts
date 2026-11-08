/** /sitemap.xml: 100 public and 20 private repositories, built fast, cached with an ETag. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { forgetListings } from "../src/core/listings.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sitemap-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error(a.error);
  for (let i = 0; i < 120; i++) {
    const pub = i < 100;
    const r = await createRepo(app, a.value, { name: `${pub ? "pub" : "priv"}${i}`, visibility: pub ? "public" : "private" });
    if (!r.ok) throw new Error(String(r.error));
  }
  forgetListings(app.db);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("lists the 100 public repositories and none of the 20 private ones, built in a bounded number of statements", async () => {
  let res!: Response;
  let body = "";
  for (let i = 0; i < 5; i++) {
    forgetListings(app.db);
    res = await fetch(`${servers.url}/sitemap.xml`);
    body = await res.text();
  }
  expect(body.match(/\/alice\/pub\d+</g)?.length).toBe(100);
  expect(body).not.toContain("priv");
  const timing = res.headers.get("server-timing") ?? "";
  for (const phase of ["repos", "render", "etag"]) expect(timing).toContain(`${phase};dur=`);
  // Counted, not timed: a cold build reads once for all 120 repositories, not once each.
  expectWork(await statements(app.db, async () => {
    forgetListings(app.db);
    await (await fetch(`${servers.url}/sitemap.xml`)).text();
  }), { max: 8 });
});

test("a repeat with If-None-Match gets a 304, a stale tag gets the document", async () => {
  const first = await fetch(`${servers.url}/sitemap.xml`);
  const etag = first.headers.get("etag")!;
  expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
  await first.text();
  const again = await fetch(`${servers.url}/sitemap.xml`, { headers: { "if-none-match": etag } });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");
  const stale = await fetch(`${servers.url}/sitemap.xml`, { headers: { "if-none-match": '"nope"' } });
  expect(stale.status).toBe(200);
  expect((await stale.text()).length).toBeGreaterThan(1000);
});
