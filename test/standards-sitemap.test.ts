/** /robots.txt and /sitemap.xml: public repositories with lastmod, never a private one, 304 on a repeat. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { forgetListings } from "../src/core/listings.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${servers.url}${path}`, { headers });
const push = async (name: string) => {
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", name)!, { message: "Start", files: [{ path: "README.md", content: "hi\n" }] });
  if (!c.ok) throw new Error(String(c.error));
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-standards-sitemap-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  for (const [name, visibility] of [["open", "public"], ["secret", "private"]] as const) {
    const r = await createRepo(app, alice, { name, visibility });
    if (!r.ok) throw new Error(String(r.error));
  }
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the sitemap lists / , /explore and the public repository, never the private one", async () => {
  const res = await get("/sitemap.xml");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("application/xml");
  const body = await res.text();
  const o = servers.url;
  expect(body).toContain(`<loc>${o}/</loc>`);
  expect(body).toContain(`<loc>${o}/explore</loc>`);
  expect(body).toContain(`<loc>${o}/alice/open</loc>`);
  expect(body).not.toContain("secret");
});

test("a push gives the repository a lastmod and changes the ETag; a repeat with the ETag is a bare 304", async () => {
  const first = await get("/sitemap.xml");
  const before = first.headers.get("etag")!;
  expect(await first.text()).not.toContain("<lastmod>");
  const again = await get("/sitemap.xml", { "if-none-match": before });
  expect(again.status).toBe(304);
  expect(await again.text()).toBe("");

  await push("open");
  await push("secret");
  // The listing is kept for a minute by design; skip the wait.
  forgetListings(app.db);
  const after = await get("/sitemap.xml", { "if-none-match": before });
  expect(after.status).toBe(200);
  expect(after.headers.get("etag")).not.toBe(before);
  const body = await after.text();
  expect(body).toMatch(/<loc>[^<]*\/alice\/open<\/loc><lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  expect(body).not.toContain("secret");
});

test("robots.txt disallows the private surfaces and names the sitemap on the request's origin", async () => {
  const res = await get("/robots.txt");
  expect(res.status).toBe(200);
  const lines = (await res.text()).split("\n");
  for (const p of ["/signin", "/signup", "/settings", "/search", "/api/"]) expect(lines).toContain(`Disallow: ${p}`);
  expect(lines).toContain(`Sitemap: ${servers.url}/sitemap.xml`);
});

test("the sitemap lists /changelog after /explore, with the newest landing's day as lastmod once one has landed", async () => {
  const before = await get("/sitemap.xml");
  const bodyBefore = await before.text();
  const etagBefore = before.headers.get("etag")!;
  const o = servers.url;
  expect(bodyBefore).toContain(`<loc>${o}/explore</loc></url>\n<url><loc>${o}/changelog</loc></url>`);

  const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'open'").get()!.id;
  const merge = (n: number, at: string) => {
    app.db.query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', 'Landed', '', ?4, 'closed', ?5)`).run(`ci${n}`, repoId, n + 100, alice.id, at);
    app.db.query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at, merged_oid) VALUES (?1, 'main', ?2, '', '', ?3, ?4, '')`).run(`ci${n}`, `c/${n}`, repoId, at);
  };
  merge(1, "2026-03-04T10:00:00.000Z");
  const first = await get("/sitemap.xml", { "if-none-match": etagBefore });
  expect(first.status).toBe(200);
  expect(await first.text()).toContain(`<loc>${o}/changelog</loc><lastmod>2026-03-04</lastmod></url>`);
  const etagFirst = first.headers.get("etag")!;
  expect(etagFirst).not.toBe(etagBefore);

  merge(2, "2026-03-09T23:00:00.000Z");
  const second = await get("/sitemap.xml", { "if-none-match": etagFirst });
  expect(second.status).toBe(200);
  expect(await second.text()).toContain("<lastmod>2026-03-09</lastmod>");
  expect(second.headers.get("etag")).not.toBe(etagFirst);
});
