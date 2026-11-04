/** #8199: a browser-looking stranger is bound on deep pages, /tree is served from a per-commit cache whose links name the commit, and the board shows it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { BEHIND_DIVISOR, STRANGER_BUDGET, finishedStrangerDeep, setCrawlClock, takeCrawl } from "../src/http/crawl.ts";
import { notePeer } from "../src/http/peer.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { crawlerShare, createPerfRecord } from "../src/perf/record.ts";
import { crawlReport } from "../src/perf/crawlers.ts";
import { clearTreeCache, treeCacheStats } from "../src/web/pages/tree_cache.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let sha = "";

const BROWSER = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36";
const from = (ip: string, extra: Record<string, string> = {}) => ({ "user-agent": BROWSER, "x-forwarded-for": ip, ...extra });
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${servers.url}${path}`, { headers, redirect: "manual" });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-anon-deep-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", isAdmin: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const r = await createRepo(app, alice, { name: "open", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "open")!, { message: "Start", files: [{ path: "a.txt", content: "hi\n" }, { path: "README.md", content: "# Open\n" }] });
  if (!c.ok) throw new Error(String(c.error));
  const head = Bun.spawnSync(["git", "--git-dir", join(dataDir, "repos", "alice", "open.git"), "rev-parse", "HEAD"]);
  sha = head.stdout.toString().trim();
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a browser User-Agent with no session shares a per-address and an overall deep budget; a signed-in person is never counted", async () => {
  const t = 5_000_000;
  setCrawlClock(app, () => t);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  for (let i = 0; i < STRANGER_BUDGET.address; i++) expect((await get(deep, from("10.1.0.1"))).status).toBe(200);
  const refused = await get(deep, from("10.1.0.1"));
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  // another address is not held back by it; the home page is not deep
  expect((await get(deep, from("10.1.0.2"))).status).toBe(200);
  expect((await get("/alice/open", from("10.1.0.1"))).status).toBe(200);
  // a person on the refused address is never counted
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  expect((await get(deep, from("10.1.0.1", { cookie }))).status).toBe(200);
});

test("a quiet address is still served after many noisy ones: there is no bucket for everyone together", async () => {
  setCrawlClock(app, () => 6_000_000);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  for (let n = 0; n < 6; n++)
    for (let i = 0; i < STRANGER_BUDGET.address + 1; i++) await get(deep, from(`10.2.0.${n + 1}`));
  expect((await get(deep, from("10.2.9.9"))).status).toBe(200);
});

test("the budget divides while the loop is behind, and the explorer's folder expansion is not counted", async () => {
  setCrawlClock(app, () => 6_500_000, true);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  const allowed = Math.floor(STRANGER_BUDGET.address / BEHIND_DIVISOR);
  for (let i = 0; i < allowed; i++) expect((await get(deep, from("10.4.0.1"))).status).toBe(200);
  expect((await get(deep, from("10.4.0.1"))).status).toBe(429);
  for (let i = 0; i < 40; i++) expect((await get("/alice/open/tree/main?fragment=explorer", from("10.4.0.2"))).status).toBe(200);
  setCrawlClock(app, () => 6_500_000, false);
});

test("while the loop is behind, strangers on many addresses share one ceiling; on time they don't; a person is never counted", async () => {
  setCrawlClock(app, () => 7_000_000, true);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  for (let i = 0; i < STRANGER_BUDGET.behindAll; i++) {
    expect((await get(deep, from(`10.3.${i >> 8}.${(i & 255) + 1}`))).status).toBe(200);
  }
  const refused = await get(deep, from("10.4.0.1"));
  expect(refused.status).toBe(429);
  expect(await refused.text()).toContain("sign in");
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  expect((await get(deep, from("10.4.0.1", { cookie }))).status).toBe(200);
  setCrawlClock(app, () => 7_000_000, false);
  expect((await get(deep, from("10.4.0.1"))).status).toBe(200);
});

test("the board counts the browser-looking traffic and the refusals", () => {
  const record = createPerfRecord();
  const at = Date.now();
  record.add("/:owner/:name/tree/:ref", { at, ms: 7000, signedIn: false, deepStranger: true, phases: [] });
  expect(crawlerShare(record, at - 1000)).toMatchObject({ strangerRequests: 1, strangerMs: 7000, crawlerRequests: 0 });
  expect(crawlReport(app).refused_by_budget.stranger).toBeGreaterThan(0);
});

test("a branch page resolves to its commit once, serves from the cache, links by commit, and a push shows at once", async () => {
  setCrawlClock(app, () => 9_000_000);
  clearTreeCache();
  const first = await get("/alice/open/tree/main", from("10.3.0.1"));
  expect(first.status).toBe(200);
  const body = await first.text();
  expect(body).toContain(`/alice/open/blob/${sha}/a.txt`);
  expect(first.headers.get("cache-control") ?? "").not.toContain("immutable");
  expect(treeCacheStats().entries).toBe(1);
  const second = await get("/alice/open/tree/main", from("10.3.0.1"));
  expect(await second.text()).toContain(`/alice/open/blob/${sha}/a.txt`);
  expect(treeCacheStats().hits).toBeGreaterThanOrEqual(1);
  // a commit-addressed listing is immutable for the edge
  const addressed = await get(`/alice/open/tree/${sha}`, from("10.3.0.1"));
  expect(addressed.headers.get("cache-control")).toContain("immutable");
  // a signed-in person is neither served from nor given the shared cache
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const mine = await get(`/alice/open/tree/${sha}`, from("10.3.0.1", { cookie }));
  expect(mine.headers.get("cache-control") ?? "").not.toContain("public");
  // a new commit moves the branch: the next read keys on it
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "open")!, { message: "More", files: [{ path: "b.txt", content: "b\n" }] });
  if (!c.ok) throw new Error(String(c.error));
  const after = await (await get("/alice/open/tree/main", from("10.3.0.1"))).text();
  expect(after).toContain("b.txt");
});

test("a hit does not read git; a signed-in reader, a tag and ?all=1 behave as the cache says", async () => {
  setCrawlClock(app, () => 12_000_000);
  clearTreeCache();
  const gitDir = join(dataDir, "repos", "alice", "open.git");
  Bun.spawnSync(["git", "--git-dir", gitDir, "tag", "v1"]);
  const anon = from("10.5.0.1");
  await get("/alice/open/tree/main", anon);
  expect(treeCacheStats().entries).toBe(1);

  // the same read with the objects gone still answers: nothing was read from git
  await rename(join(gitDir, "objects"), join(gitDir, "objects.away"));
  try {
    const hit = await get("/alice/open/tree/main", anon);
    expect(hit.status).toBe(200);
    expect(await hit.text()).toContain("a.txt");
    expect((await get("/alice/open/tree/main/nowhere", anon)).status).toBe(404);
  } finally {
    await rename(join(gitDir, "objects.away"), join(gitDir, "objects"));
  }

  // ?all=1 has its own key
  await get("/alice/open/tree/main?all=1", anon);
  expect(treeCacheStats().entries).toBe(2);

  // a tag is not resolved: it is read from git and kept out of the cache
  const tagged = await get("/alice/open/tree/v1", anon);
  expect(tagged.status).toBe(200);
  expect(treeCacheStats().entries).toBe(2);

  // a signed-in person neither reads nor fills the cache, and links by branch name
  const before = treeCacheStats();
  const cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const mine = await (await get("/alice/open/tree/main", from("10.5.0.1", { cookie }))).text();
  expect(mine).toContain("/alice/open/blob/main/a.txt");
  expect(treeCacheStats()).toEqual(before);

  // a private repository is not cached either, for its owner
  const p = await createRepo(app, alice, { name: "hidden", visibility: "private" });
  if (!p.ok) throw new Error(String(p.error));
  await commitToBranch(app, alice, getRepo(app.db, "alice", "hidden")!, { message: "x", files: [{ path: "s.txt", content: "s\n" }] });
  expect((await get("/alice/hidden/tree/main", from("10.5.0.1", { cookie }))).status).toBe(200);
  expect((await get("/alice/hidden/tree/main", anon)).status).toBe(404);
  expect(treeCacheStats().entries).toBe(2);
});

test("the pages behind the listing's commit links carry the immutable headers for an anonymous reader", async () => {
  setCrawlClock(app, () => 13_000_000);
  const body = await (await get("/alice/open/tree/main", from("10.6.0.1"))).text();
  const blob = /\/alice\/open\/blob\/[0-9a-f]{40}\/a\.txt/.exec(body)?.[0];
  expect(blob).toBeDefined();
  expect((await get(blob!, from("10.6.0.1"))).headers.get("cache-control")).toContain("immutable");
  expect((await get(blob!.replace("/blob/", "/tree/").replace("/a.txt", ""), from("10.6.0.1"))).headers.get("cache-control")).toContain("immutable");
});

test("pages queued past their share count as behind even with the loop on time, and stop counting once answered", () => {
  const fresh = {} as App;
  let now = 8_000_000;
  setCrawlClock(fresh, () => now, false);
  let n = 0;
  const ask = () => {
    n++;
    const request = new Request("http://forge.test/alice/open/blob/c/a.txt", { headers: { "user-agent": "Mozilla/5.0 Chrome/150.0" } });
    notePeer(request, `10.9.${n >> 8}.${(n & 255) + 1}`);
    return { request, verdict: takeCrawl(fresh, request, "/alice/open/blob/c/a.txt") };
  };
  const open: Request[] = [];
  for (let i = 0; i < STRANGER_BUDGET.inFlight; i++) {
    const a = ask();
    expect(a.verdict).toBeUndefined();
    open.push(a.request);
  }
  for (let i = 0; i < STRANGER_BUDGET.behindAll; i++) {
    const a = ask();
    expect(a.verdict).toBeUndefined();
    open.push(a.request);
  }
  expect(ask().verdict?.scope).toBe("stranger");
  for (const r of open) finishedStrangerDeep(fresh, r);
  expect(ask().verdict).toBeUndefined();
  // A finish that never came is forgotten after a minute.
  for (let i = 0; i < STRANGER_BUDGET.inFlight; i++) ask();
  now += 61_000;
  for (let i = 0; i < 90; i++) expect(ask().verdict).toBeUndefined();
});

test("a made-up Authorization header buys nothing: it's counted like anyone with no account", async () => {
  setCrawlClock(app, () => 9_500_000);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  const statuses: number[] = [];
  for (let i = 0; i <= STRANGER_BUDGET.address; i++) statuses.push((await get(deep, from("10.8.0.1", { authorization: "Bearer made-up" }))).status);
  expect(statuses.at(-1)).toBe(429);
});
