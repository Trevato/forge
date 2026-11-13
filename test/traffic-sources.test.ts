/**
 * Where people come from and where they go (#9427): the beacon's referrer and
 * campaign fields are reduced to what may be kept, buffered off the request
 * path, told apart from scrapers, narrowed by a filter, followed through a
 * path to a goal, and every number is counted again by the probe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { entriesOf, githubSummary, pullGithub, githubConfig, type Fetch } from "../src/perf/github_traffic.ts";
import { hostOf, originOf, outboundOf, isScraperAgent } from "../src/perf/sources.ts";
import { probeViews } from "../src/perf/views_probe.ts";
import { funnel, parseSteps, readVisits, sourcesReport } from "../src/perf/views_report.ts";
import { VISITOR_DAY_MAX, flushViews, noteView, pendingViews } from "../src/perf/views_store.ts";
import { parseReport } from "../src/web/measure.ts";
import { entry, readableScope, trafficLines } from "../src/tui/screens/trafficview.ts";
import { beaconJs } from "../src/web/beacon.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
const PERSON = "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36";
const BOT = "Mozilla/5.0 (compatible; Reflectionbot/1.0)";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-sources-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "ada", email: "ada@forge.local", password: "correct-horse-battery", isAdmin: true });
  if (!made.ok) throw new Error(made.error);
  cookie = `forge_session=${createSession(app.db, made.value.id).token}`;
});
afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

const at = Date.now();
const view = (scope: string, client: string, path: string, o: { ref?: string; q?: string; out?: string } = {}, agent = PERSON, when = at) =>
  noteView(app.db, { scope, path, origin: originOf(o.ref, o.q, "forge.test", o.out), client, agent, at: when });

describe("what is kept of a referrer", () => {
  test("only hosts, only the three utm fields, only named outbound links", () => {
    expect(hostOf("https://www.Espodev.com/blog/post?token=secret#x")).toBe("espodev.com");
    expect(hostOf("javascript:alert(1)")).toBe("");
    expect(hostOf("https://bad host/")).toBe("");
    const o = originOf("https://news.example/item?id=1", "?utm_source=Post&utm_medium=social&utm_campaign=launch-1&other=1", "forge.test", "github.com");
    expect(o).toEqual({ refHost: "news.example", source: "post", medium: "social", campaign: "launch-1", out: "github.com" });
    expect(originOf("https://forge.test/explore", "", "forge.test:3000", undefined).source).toBe("");
    expect(originOf(undefined, "?utm_source=<script>", "x", "evil.example")).toEqual({ refHost: "", source: "", medium: "", campaign: "", out: "" });
    expect(outboundOf("gist.github.com")).toBe("github.com");
    expect(outboundOf("notgithub.com")).toBe("");
  });
  test("a program is not a person", () => {
    expect(isScraperAgent(BOT)).toBe(true);
    expect(isScraperAgent("")).toBe(true);
    expect(isScraperAgent("HeadlessChrome/120")).toBe(true);
    expect(isScraperAgent(PERSON)).toBe(false);
  });
  test("the beacon's new fields are optional, bounded and the old beacon still passes", () => {
    const base = { path: "/", cls: 0 };
    expect(parseReport(JSON.stringify(base))).toEqual({ path: "/", ttfb: null, load: null, lcp: null, inp: null, cls: 0 });
    expect(parseReport(JSON.stringify({ ...base, ref: "https://a.test/", q: "?utm_source=x", out: "github.com" }))).toMatchObject({ ref: "https://a.test/", out: "github.com" });
    expect(parseReport(JSON.stringify({ ...base, ref: "x".repeat(301) }))).toBe("malformed");
    expect(parseReport(JSON.stringify({ ...base, out: 5 }))).toBe("malformed");
    expect(beaconJs).toContain("document".slice(0, 0) + "referrer");
    expect(new TextEncoder().encode(beaconJs).length).toBeLessThan(2048);
  });
});

describe("buffered views, visits and filters", () => {
  test("a view costs no SQL until the flush, and the flush writes them in one go", () => {
    // Ada from a post (campaign), reads two pages and leaves for GitHub.
    view("forge", "10.0.0.1", "/", { ref: "https://blog.example/post", q: "?utm_source=post&utm_medium=social&utm_campaign=launch" }, PERSON, at);
    view("forge", "10.0.0.1", "/explore", { ref: "https://forge.test/" }, PERSON, at + 1000);
    view("forge", "10.0.0.1", "/explore", { out: "github.com" }, PERSON, at + 2000);
    // Bo comes from the personal site and bounces.
    view("forge", "10.0.0.2", "/", { ref: "https://espodev.com/" }, PERSON, at + 3000);
    // Cy arrives direct and signs up.
    view("forge", "10.0.0.3", "/", {}, PERSON, at + 4000);
    view("forge", "10.0.0.3", "/signup", {}, PERSON, at + 5000);
    // A scraper, and another scope.
    view("forge", "10.0.0.9", "/", {}, BOT, at + 6000);
    view("app1", "10.0.0.1", "/", { ref: "https://espodev.com/" }, PERSON, at + 7000);
    const before = app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM traffic_view").get()!.n;
    expect(before).toBe(0);
    expect(pendingViews(app.db)).toBe(8);
    expect(flushViews(app.db, at + 10_000)).toBe(8);
    expect(pendingViews(app.db)).toBe(0);
    expect(app.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM traffic_view").get()!.n).toBe(8);
  });

  test("visits take the first view's source and the last view's exit; scrapers stay apart; scopes stay apart", () => {
    const visits = readVisits(app.db, "forge", at - 1000);
    expect(visits.length).toBe(4);
    const r = sourcesReport(app.db, "forge", "7d", { who: "people" }, at + 20_000);
    expect(r.visits).toBe(3);
    expect(r.scrapers).toBe(1);
    expect(r.pageViews).toBe(6);
    expect(r.pagesPerVisit).toBe(2);
    expect(r.sources.map((s) => `${s.key}:${s.visits}`).sort()).toEqual(["(direct):1", "espodev.com:1", "post:1"]);
    expect(r.campaigns).toEqual([{ key: "launch", visits: 1 }]);
    expect(r.landings[0]).toEqual({ key: "/", visits: 3 });
    expect(r.exits.map((e) => e.key).sort()).toEqual(["/", "/explore", "/signup"]);
    expect(r.outbound).toEqual([{ key: "github.com", visits: 1 }]);
    expect(r.days.at(-1)?.visits).toBeGreaterThan(0);
    expect(sourcesReport(app.db, "forge", "7d", { who: "scrapers" }, at + 20_000).visits).toBe(1);
    expect(sourcesReport(app.db, "app1", "7d", { who: "people" }, at + 20_000).visits).toBe(1);
  });

  test("choosing a value narrows every other panel", () => {
    const r = sourcesReport(app.db, "forge", "7d", { who: "people", source: "post" }, at + 20_000);
    expect(r.visits).toBe(1);
    expect(r.exits).toEqual([{ key: "/explore", visits: 1 }]);
    expect(r.campaigns).toEqual([{ key: "launch", visits: 1 }]);
    expect(r.outbound).toEqual([{ key: "github.com", visits: 1 }]);
    const direct = sourcesReport(app.db, "forge", "7d", { who: "people", source: "" }, at + 20_000);
    expect(direct.exits).toEqual([{ key: "/signup", visits: 1 }]);
  });

  test("a path from a source to a goal counts each step and what was lost", () => {
    expect(parseSteps("/, /signup, out:github.com, nonsense, ../x")).toEqual(["/", "/signup", "out:github.com"]);
    const all = funnel(app.db, "forge", "7d", { who: "people" }, ["/", "/signup"], at + 20_000);
    expect(all.map((s) => s.visits)).toEqual([3, 3, 1]);
    expect(all[2]).toMatchObject({ lost: 2, lostShare: 67 });
    const fromPost = funnel(app.db, "forge", "7d", { who: "people", source: "post" }, ["/explore", "out:github.com"], at + 20_000);
    expect(fromPost.map((s) => s.visits)).toEqual([1, 1, 1]);
    const wrongOrder = funnel(app.db, "forge", "7d", { who: "people" }, ["out:github.com", "/"], at + 20_000);
    expect(wrongOrder.map((s) => s.visits)).toEqual([3, 1, 0]);
  });

  test("the probe counts every number again by another route and they agree", () => {
    const p = probeViews(app.db, "forge", "7d", "people", at + 20_000, { dimension: "source", key: "post", steps: "/,/signup" });
    const ids = p.numbers.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["visits", "page_views", "outbound", "scrapers", "cell", "funnel_0", "funnel_2"]));
    for (const n of p.numbers) expect({ id: n.id, agrees: n.agrees }).toEqual({ id: n.id, agrees: true });
    expect(p.numbers.find((n) => n.id === "cell")?.value).toBe(1);
    const exit = probeViews(app.db, "forge", "7d", "people", at + 20_000, { dimension: "exit", key: "/explore" });
    expect(exit.numbers.find((n) => n.id === "cell")).toMatchObject({ value: 1, recomputed: 1 });
    const direct = probeViews(app.db, "forge", "7d", "people", at + 20_000, { dimension: "source", key: "(direct)" });
    expect(direct.numbers.find((n) => n.id === "cell")).toMatchObject({ value: 1, recomputed: 1 });
  });

  test("the buffer is bounded and a read of visits walks the index", () => {
    const plan = app.db
      .query("EXPLAIN QUERY PLAN SELECT day, visitor, path, source, medium, campaign, out_host, scraper FROM traffic_view WHERE scope = ?1 AND at >= ?2 ORDER BY at, id LIMIT ?3")
      .all("x", 0, 5)
      .map((r) => (r as { detail: string }).detail)
      .join("\n");
    expect(plan).toContain("traffic_view_scope_at");
    expect(plan).not.toMatch(/^SCAN (?!.*USING)/m);
  });
});

describe("through the doors", () => {
  test("a report on the forge's own door is buffered with its route, not its path, and the page and probe answer an admin alone", async () => {
    const res = await fetch(`${servers.url}/_measure`, {
      method: "POST",
      headers: { origin: servers.url, "user-agent": PERSON },
      body: JSON.stringify({ path: "/explore", cls: 0, ref: "https://news.example/x", q: "?utm_source=hn&utm_campaign=show" }),
    });
    expect(res.status).toBe(204);
    expect(pendingViews(app.db)).toBe(1);
    flushViews(app.db);
    const row = app.db.query<{ path: string; source: string; campaign: string }, []>("SELECT path, source, campaign FROM traffic_view WHERE source = 'hn'").get()!;
    expect(row).toEqual({ path: "/explore", source: "hn", campaign: "show" });

    const page = await fetch(`${servers.url}/settings/traffic/sources?window=7d&source=hn&steps=/explore,out:github.com`, { headers: { cookie } });
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("What it cannot see");
    expect(body).toContain("Scrapers are told by user agent");
    expect(body).toContain("/api/v1/admin/traffic/probe?");
    expect(body).toContain("Narrowed to");
    expect(await (await fetch(`${servers.url}/settings/traffic/sources`)).text()).not.toContain("How it was counted");
    expect((await fetch(`${servers.url}/settings/traffic/sources?app=nope`, { headers: { cookie } })).status).toBe(404);

    const probe = await fetch(`${servers.url}/api/v1/admin/traffic/probe?scope=forge&number=visits`, { headers: { cookie } });
    expect(probe.status).toBe(200);
    const json = (await probe.json()) as { numbers: { id: string; agrees: boolean }[] };
    expect(json.numbers.map((n) => n.id)).toEqual(["visits"]);
    expect(json.numbers[0]!.agrees).toBe(true);
    expect(await (await fetch(`${servers.url}/api/v1/admin/traffic/probe`)).text()).not.toContain("agrees");
  });
});

describe("GitHub's own traffic", () => {
  const answers: Record<string, unknown> = {
    referrers: [{ referrer: "espodev.com", count: 9, uniques: 4 }],
    views: { count: 5, uniques: 3, views: [{ timestamp: "2026-11-06T00:00:00Z", count: 5, uniques: 3 }] },
    clones: { count: 2, uniques: 1, clones: [{ timestamp: "2026-11-07T00:00:00Z", count: 2, uniques: 1 }] },
  };
  const seen: { url: string; auth: string }[] = [];
  const fake: Fetch = async (url, init) => {
    seen.push({ url, auth: init.headers["authorization"] ?? "" });
    const kind = url.includes("referrers") ? "referrers" : url.includes("views") ? "views" : "clones";
    return Response.json(answers[kind]);
  };

  test("needs a token and a valid repository, validates answers, and stores them", async () => {
    expect(githubConfig({})).toBeNull();
    expect(githubConfig({ FORGE_GITHUB_TOKEN: "t", FORGE_GITHUB_REPOS: "../x, a/b" })?.repos).toEqual(["a/b"]);
    expect(entriesOf("views", { views: [{ timestamp: "nope", count: 1, uniques: 1 }] }, "2026-11-08")).toBe("malformed");
    expect(entriesOf("referrers", [{ referrer: "<b>", count: 1, uniques: 1 }], "2026-11-08")).toBe("malformed");
    const stored = await pullGithub(app.db, { token: "tok", repos: ["trevato/forge"] }, fake, Date.parse("2026-11-08T03:00:00Z"));
    expect(stored).toBe(1);
    expect(seen.map((s) => s.url)).toEqual([
      "https://api.github.com/repos/trevato/forge/traffic/popular/referrers",
      "https://api.github.com/repos/trevato/forge/traffic/views",
      "https://api.github.com/repos/trevato/forge/traffic/clones",
    ]);
    expect(seen[0]!.auth).toBe("Bearer tok");
    const [s] = githubSummary(app.db, "2026-11-01");
    expect(s).toMatchObject({ repo: "trevato/forge", views: 5, viewers: 3, clones: 2, error: null });
    expect(s!.referrers).toEqual([{ key: "espodev.com", count: 9, uniques: 4 }]);
    // Pulling again the same day replaces rather than doubles.
    await pullGithub(app.db, { token: "tok", repos: ["trevato/forge"] }, fake, Date.parse("2026-11-08T05:00:00Z"));
    expect(githubSummary(app.db, "2026-11-01")[0]!.views).toBe(5);
    expect(JSON.stringify(app.db.query("SELECT * FROM github_pull").all())).not.toContain("tok");
  });

  test("a refusal is recorded, not thrown, and stores nothing new", async () => {
    const refuse: Fetch = async () => new Response("no", { status: 403 });
    expect(await pullGithub(app.db, { token: "tok", repos: ["a/b"] }, refuse)).toBe(0);
    const row = app.db.query<{ error: string }, []>("SELECT error FROM github_pull WHERE repo = 'a/b'").get()!;
    expect(row.error).toBe("referrers: GitHub answered 403");
  });
});

describe("review: caps, cache, gates and the terminal door", () => {
  test("one visitor cannot fill a day with invented paths", () => {
    const scope = "capped-scope";
    for (let i = 0; i < VISITOR_DAY_MAX + 20; i++) view(scope, "10.9.9.9", `/junk-${i}`);
    view(scope, "10.1.1.1", "/real");
    flushViews(app.db);
    const n = () =>
      app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM traffic_view WHERE scope = ?1").get(scope)!.n;
    expect(n()).toBe(VISITOR_DAY_MAX + 1);
    expect(app.db.query("SELECT 1 FROM traffic_view WHERE scope = ?1 AND path = '/real'").all(scope)).toHaveLength(1);
  });

  test("a read is held briefly and a write drops what is held", () => {
    const scope = "held-scope";
    const since = Date.now() - 86_400_000;
    view(scope, "10.2.2.2", "/a");
    flushViews(app.db);
    const first = readVisits(app.db, scope, since);
    expect(readVisits(app.db, scope, since)).toBe(first);
    view(scope, "10.3.3.3", "/b");
    flushViews(app.db);
    expect(readVisits(app.db, scope, since)).toHaveLength(2);
  });

  test("a non-admin is refused both pages and the probe; the pages carry the security floor", async () => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "guest1", email: "g1@forge.local", password: "correct-horse-battery", isAdmin: false });
    if (!made.ok) throw new Error(made.error);
    const plain = `forge_session=${createSession(app.db, made.value.id).token}`;
    // The forge's page is an admin route, refused at the gate; an app's is not found.
    for (const [path, status] of [["/settings/traffic/sources", 403], ["/ada/none/settings/app/traffic", 404]] as const)
      expect((await fetch(`${servers.url}${path}`, { headers: { cookie: plain } })).status).toBe(status);
    expect((await fetch(`${servers.url}/api/v1/admin/traffic/probe?scope=forge`, { headers: { cookie: plain } })).status).not.toBe(200);
    const ok = await fetch(`${servers.url}/settings/traffic/sources`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("referrer-policy")).toBeTruthy();
    expect(ok.headers.get("content-security-policy")).toBeTruthy();
    expect(await ok.text()).toContain("reported by the visitor");
  });

  test("the terminal reads what the page reads, to the same people", () => {
    const admin = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'ada'").get()!;
    const asAdmin = { db: app.db, app, user: { id: admin.id, isAdmin: true } } as never;
    const asGuest = { db: app.db, app, user: { id: "x", isAdmin: false } } as never;
    expect(readableScope(asAdmin)).toBe("forge");
    expect(readableScope(asGuest)).toBeUndefined();
    expect(readableScope({ db: app.db, app } as never)).toBeUndefined();
    expect(entry.offered(asGuest)).toBe(false);
    expect(trafficLines(asAdmin, "forge", "7d", { who: "people" }, ["/"]).length).toBeGreaterThan(1);
  });
});
