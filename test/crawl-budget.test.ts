/** #8129: robots.txt names the deep paths, a crawler past its budget gets 429 before page work, a person never does, addressed pages are immutable. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { AGENT_BUDGET, CRAWL_BUDGET, DEEP_SEGMENTS, SHARED_BUDGET, agentOf, crawlAgentCount, isCrawler, setCrawlClock, takeCrawl } from "../src/http/crawl.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { crawlerShare, createPerfRecord } from "../src/perf/record.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let sha = "";

const BOT = "Mozilla/5.0 (compatible; Reflectionbot/1.0; +https://example.test/bot)";
const PASSWORD = "a-good-passphrase";
/** A token for `username`, minted through the API as a client would. */
const mintToken = async (username: string, scope: string): Promise<string> => {
  const res = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: scope === "admin", username, password: PASSWORD, name: "t", scope }),
  });
  return ((await res.json()) as { token: string }).token;
};
const get = (path: string, headers: Record<string, string> = {}) => fetch(`${servers.url}${path}`, { headers, redirect: "manual" });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-crawl-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", isAdmin: true });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const r = await createRepo(app, alice, { name: "open", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  const c = await commitToBranch(app, alice, getRepo(app.db, "alice", "open")!, { message: "Start", files: [{ path: "a.txt", content: "hi\n" }] });
  if (!c.ok) throw new Error(String(c.error));
  const git = Bun.spawnSync(["git", "--git-dir", join(dataDir, "repos", "alice", "open.git"), "rev-parse", "HEAD"]);
  sha = git.stdout.toString().trim();
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("robots.txt disallows the deep paths at every ref, asks for a crawl delay, and leaves roots open", async () => {
  const lines = (await (await get("/robots.txt")).text()).split("\n");
  for (const segment of DEEP_SEGMENTS) expect(lines).toContain(`Disallow: /*/*/${segment}`);
  expect(lines).toContain("Disallow: /origins/");
  expect(lines).toContain("Crawl-delay: 10");
  expect(lines).not.toContain("Disallow: /");
});

test("a crawler is told by its User-Agent's product token, a browser and curl are not crawlers", () => {
  expect(agentOf(BOT)).toBe("reflectionbot");
  expect(isCrawler(new Request("http://x/", { headers: { "user-agent": BOT } }))).toBe(true);
  expect(isCrawler(new Request("http://x/", { headers: { "user-agent": "Mozilla/5.0 Firefox/130.0" } }))).toBe(false);
  expect(isCrawler(new Request("http://x/", { headers: { "user-agent": "curl/8.0" } }))).toBe(false);
  expect(isCrawler(new Request("http://x/", { method: "POST", headers: { "user-agent": BOT } }))).toBe(false);
});

const from = (ip: string, ua = BOT) => ({ "user-agent": ua, "x-forwarded-for": ip });

test("past its deep budget an address gets 429 with Retry-After; a person on the same path is not throttled", async () => {
  let t = 1_000_000;
  setCrawlClock(app, () => t);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  for (let i = 0; i < CRAWL_BUDGET.deep; i++) expect((await get(deep, from("10.0.0.1"))).status).toBe(200);
  const refused = await get(deep, from("10.0.0.1"));
  expect(refused.status).toBe(429);
  expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  expect(refused.headers.get("x-content-type-options")).toBe("nosniff");
  // The same address is refused the whole deep family, not just that URL, and not by rotating its name.
  expect((await get("/alice/open/commits", from("10.0.0.1"))).status).toBe(429);
  expect((await get(deep, from("10.0.0.1", "Rotatedbot/9.9"))).status).toBe(429);
  expect((await get(deep, { "x-forwarded-for": "10.0.0.1", "user-agent": "" })).status).toBe(429);
  // Another address has its own budget.
  expect((await get(deep, from("10.0.0.2"))).status).toBe(200);
  // A person — no crawler UA — is never counted.
  for (let i = 0; i < CRAWL_BUDGET.deep * 3; i++) expect((await get(deep, from("10.0.0.1", "Mozilla/5.0 Firefox/130.0"))).status).toBe(200);
  // The budget is a minute: it comes back.
  t += 61_000;
  expect((await get(deep, from("10.0.0.1"))).status).toBe(200);
});

test("a token is never counted, even with a bot User-Agent", async () => {
  const token = await mintToken("alice", "admin");
  const deep = `/alice/open/blob/${sha}/a.txt`;
  for (let i = 0; i < CRAWL_BUDGET.deep * 3; i++)
    expect((await get(deep, { ...from("10.0.0.9"), authorization: `Bearer ${token}` })).status).toBe(200);
});

test("a spoofed name cannot spend a real crawler's budget: the address is spent first", async () => {
  setCrawlClock(app, () => 2_000_000);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  // One script sends the real crawler's name from one address: it stops at the address budget.
  let ok = 0;
  for (let i = 0; i < 40; i++) if ((await get(deep, from("10.1.0.1", "Googlebot/2.1"))).status === 200) ok++;
  expect(ok).toBe(CRAWL_BUDGET.deep);
  // The real one, from its own address, still gets in.
  expect((await get(deep, from("10.1.0.2", "Googlebot/2.1"))).status).toBe(200);
});

test("many addresses sharing one name meet the agent cap; many names meet the shared ceiling", async () => {
  setCrawlClock(app, () => 3_000_000);
  const deep = `/alice/open/blob/${sha}/a.txt`;
  let ok = 0;
  for (let i = 0; i < AGENT_BUDGET.deep + 6; i++) if ((await get(deep, from(`10.2.0.${i + 1}`, "Swarmbot/1.0"))).status === 200) ok++;
  expect(ok).toBe(AGENT_BUDGET.deep);
  setCrawlClock(app, () => 4_000_000);
  ok = 0;
  for (let i = 0; i < SHARED_BUDGET.deep + 6; i++) if ((await get(deep, from(`10.3.${i}.1`, `Name${i}bot/1.0`))).status === 200) ok++;
  expect(ok).toBe(SHARED_BUDGET.deep);
});

test("rotating names does not grow the limiters without bound", () => {
  setCrawlClock(app, () => 6_000_000);
  for (let i = 0; i < 600; i++)
    takeCrawl(app, new Request("http://x/a/b", { headers: { "user-agent": `Spin${i}bot/1.0` } }), "/a/b");
  expect(crawlAgentCount(app)).toBeLessThanOrEqual(257);
});

test("while the main thread is behind a crawler's budget shrinks", async () => {
  let t = 7_000_000;
  setCrawlClock(app, () => t, true);
  const deep = `/alice/open/commits`;
  const allowed = Math.floor(CRAWL_BUDGET.deep / 4);
  for (let i = 0; i < allowed; i++) expect((await get(deep, { "user-agent": "Lagbot/1.0", "x-forwarded-for": "10.4.0.1" })).status).toBe(200);
  expect((await get(deep, { "user-agent": "Lagbot/1.0", "x-forwarded-for": "10.4.0.1" })).status).toBe(429);
  setCrawlClock(app, () => t, false);
});

test("a blob or commit at a full sha is immutable for an anonymous reader; a branch name is not", async () => {
  const blob = await get(`/alice/open/blob/${sha}/a.txt`);
  expect(blob.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=86400, immutable");
  expect(blob.headers.get("vary")).toContain("Cookie");
  const commit = await get(`/alice/open/commit/${sha}`);
  expect(commit.headers.get("cache-control")).toBe("public, max-age=31536000, s-maxage=86400, immutable");
  const branch = await get(`/alice/open/blob/main/a.txt`);
  expect(branch.headers.get("cache-control") ?? "").not.toContain("immutable");
  // A cookie that carries no identity still changes the page (a theme, a flash): never shared.
  const theme = await get(`/alice/open/blob/${sha}/a.txt`, { cookie: "forge_theme=dark" });
  expect(theme.headers.get("cache-control") ?? "").not.toContain("public");
  const signedIn = await get(`/alice/open/blob/${sha}/a.txt`, { cookie: `forge_session=${createSession(app.db, alice.id).token}` });
  expect(signedIn.headers.get("cache-control") ?? "").not.toContain("public");
});

test("the performance record knows the crawlers' share of answering time", () => {
  const record = createPerfRecord();
  const at = Date.now();
  record.add("/:owner/:name/blob/:ref/*path", { at, ms: 300, signedIn: false, crawler: true, phases: [] });
  record.add("/:owner/:name/blob/:ref/*path", { at, ms: 100, signedIn: true, phases: [] });
  const share = crawlerShare(record, at - 1000);
  expect(share).toEqual({ requests: 2, crawlerRequests: 1, ms: 400, crawlerMs: 300, strangerRequests: 0, strangerMs: 0, share: 0.75 });
});

test("the crawler board door is an admin's: a non-admin and an anonymous caller are told it is not there, an admin gets the shape", async () => {
  expect((await get("/api/v1/admin/crawlers")).status).toBe(404);
  const bob = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!bob.ok) throw new Error(bob.error);
  const bobToken = await mintToken("bob", "read");
  expect((await get("/api/v1/admin/crawlers", { authorization: `Bearer ${bobToken}` })).status).toBe(404);
  const body = (await (await get("/api/v1/admin/crawlers", { authorization: `Bearer ${await mintToken("alice", "admin")}` })).json()) as any;
  expect(body.window_minutes).toBe(15);
  expect(body.refused.length).toBeGreaterThan(0);
  expect(body.refused_by_budget.address).toBeGreaterThan(0);
  expect(body.refused_by_budget.agent).toBeGreaterThan(0);
  expect(body.refused_by_budget.shared).toBeGreaterThan(0);
});
