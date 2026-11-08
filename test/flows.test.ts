/** Flows (#9434): versions, pins, changelog, the radar and the page — all with no crew and no model credential. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getRepo } from "../src/core/repos.ts";
import { readPins } from "../src/flows/pins.ts";
import { readRadar, refreshRadar } from "../src/flows/radar.ts";
import { compareSemver, gapOf, parseSemver } from "../src/flows/semver.ts";
import { RateLimiter } from "../src/core/ratelimit.ts";
import { getUserById, type User } from "../src/core/users.ts";
import { createRepo } from "../src/actions/repos.ts";
import { MAX_SOURCES, probeLinks, type Reads } from "../src/flows/probe.ts";
import { startRadar } from "../src/flows/start.ts";
import { followHealth, plainUrl, readFlows } from "../src/flows/view.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { PREVIEW_ADMIN, PREVIEW_REPO } from "../src/spawn/preview-looks.ts";
import { seedPreview } from "../src/spawn/preview-seed.ts";

const v = (s: string) => parseSemver(s)!;

describe("semver", () => {
  test("parses and rejects", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
    expect(parseSemver("1.2")).toBeUndefined();
    expect(parseSemver("latest")).toBeUndefined();
  });
  test("orders, a release above its prerelease", () => {
    expect(compareSemver(v("1.10.0"), v("1.9.9"))).toBeGreaterThan(0);
    expect(compareSemver(v("2.0.0-rc.1"), v("2.0.0"))).toBeLessThan(0);
  });
  test("names the gap", () => {
    expect(gapOf(v("1.2.3"), v("2.0.0"))).toBe("major");
    expect(gapOf(v("1.2.3"), v("1.3.0"))).toBe("minor");
    expect(gapOf(v("1.2.3"), v("1.2.4"))).toBe("patch");
    expect(gapOf(v("1.2.3"), v("1.2.3"))).toBe("none");
    expect(gapOf(v("1.2.3"), v("1.0.0"))).toBe("none");
  });
});

describe("pins and changelog", () => {
  test("reads exact floors, skips tags and bad names", () => {
    const pins = readPins(JSON.stringify({ dependencies: { zed: "^1.2.3", "bad name": "1.0.0", tagged: "latest" }, devDependencies: { "@a/b": "~0.4.0" } }));
    expect(pins.map((p) => [p.name, p.version, p.dev])).toEqual([["@a/b", "0.4.0", true], ["tagged", "", false], ["zed", "1.2.3", false]]);
    expect(readPins("{nope")).toEqual([]);
  });
});

let dir: string;
let app: App;
let servers: Servers;
const KEY = "flows-test-key";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flows-"));
  app = createApp({ dataDir: dir, port: 0, previewIdentityKey: KEY });
  const seeded = await seedPreview(app, { FORGE_APP_ENV: "preview" });
  if (!seeded.ok) throw new Error(seeded.error);
  servers = await serve(app);
}, 30_000);
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the radar and the view", () => {
  test("stores what upstream says, outdated first, an unreachable one marked", async () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const pins = readPins(JSON.stringify({ dependencies: { a: "1.0.0", b: "2.0.0", c: "1.0.0" } }));
    const n = await refreshRadar(app.db, repo.id, pins, async (name) =>
      name === "a" ? { latest: "1.0.0" } : name === "b" ? { latest: "3.1.0" } : "registry not reachable");
    expect(n).toBe(3);
    const lines = readRadar(app.db, repo.id, pins);
    expect(lines.map((l) => [l.name, l.gap, l.error])).toEqual([["b", "major", ""], ["a", "none", ""], ["c", "none", "registry not reachable"]]);
  });
  test("lists forks out and a followed source in", () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at, behind) VALUES ('s1', ?1, 'https://example.com/x.git', 'main', 'u1', '2026-11-01T00:00:00Z', 2)").run(repo.id);
    const view = readFlows(app.db, repo, undefined);
    expect(view.inbound.find((l) => l.kind === "source")?.state).toBe("2 changes behind");
  });
  test("a followed URL shows no userinfo, query or fragment", () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    app.db.query("INSERT INTO repo_source (id, repo_id, url, branch, by_id, created_at) VALUES ('s2', ?1, 'https://bob:sekret@example.org/y.git?token=zz#f', 'main', 'u1', '2026-11-02T00:00:00Z')").run(repo.id);
    app.db.query("INSERT OR REPLACE INTO repo_upstream (repo_id, url, branch, by_id, updated_at) VALUES (?1, 'https://al:pw@example.net/z.git', 'main', 'u1', '2026-11-02T00:00:00Z')").run(repo.id);
    const text = JSON.stringify(readFlows(app.db, repo, undefined));
    expect(text).toContain("example.org/y.git");
    expect(text).toContain("example.net/z.git");
    for (const secret of ["sekret", "bob", "pw@", "token=zz"]) expect(text).not.toContain(secret);
    expect(plainUrl("git@host.example:me/r.git")).toBe("host.example:me/r.git");
  });
});

describe("starting the radar", () => {
  const repoNow = () => getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
  const userNamed = (name: string) => app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(name);
  const fresh = () => new RateLimiter({ perMinute: 2, adminPerMinute: 2, enabled: true });

  test("refuses a non-admin and an agent, and writes nothing", async () => {
    const repo = repoNow();
    const before = app.db.query("SELECT COUNT(*) AS n FROM dep_latest WHERE repo_id = ?").get(repo.id);
    const lookup = async () => ({ latest: "9.9.9" });
    const stranger = { ...getUserById(app.db, userNamed(PREVIEW_ADMIN)!.id)!, id: "nobody", isAdmin: false } as User;
    const agent = { ...getUserById(app.db, userNamed(PREVIEW_ADMIN)!.id)!, kind: "agent" } as User;
    for (const who of [undefined, stranger, agent]) {
      const r = await startRadar(app, repo, who, lookup, fresh());
      expect(r).toEqual({ ok: false, why: "Only an admin of this repository can do this." });
    }
    expect(app.db.query("SELECT COUNT(*) AS n FROM dep_latest WHERE repo_id = ?").get(repo.id)).toEqual(before);
  });

  test("an admin's run stores the answers; a second at once is refused; the rate limit holds", async () => {
    const repo = repoNow();
    const admin = getUserById(app.db, userNamed(PREVIEW_ADMIN)!.id)!;
    // pinsOf reads the repository; stand in for it with the pins the run stores through refreshRadar.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async () => { await gate; return { latest: "1.1.0" }; };
    const limiter = fresh();
    const first = startRadar(app, repo, admin, slow, limiter);
    await Promise.resolve();
    const second = await startRadar(app, repo, admin, slow, limiter);
    release();
    expect((await first).ok).toBe(true);
    expect(second).toEqual({ ok: false, why: "A read is already running for this repository." });
    const limited = fresh();
    await startRadar(app, repo, admin, slow, limited);
    await startRadar(app, repo, admin, slow, limited);
    const third = await startRadar(app, repo, admin, slow, limited);
    expect(third.ok).toBe(false);
    expect(!third.ok && third.why).toMatch(/^Too many reads/);
  });

  test("a run is bounded: limited concurrency and a total deadline", async () => {
    const repo = repoNow();
    const pins = readPins(JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`p${i}`, "1.0.0"])) }));
    let live = 0;
    let peak = 0;
    const lookup = async () => { live++; peak = Math.max(peak, live); await Bun.sleep(5); live--; return { latest: "1.0.1" }; };
    expect(await refreshRadar(app.db, repo.id, pins, lookup)).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    const slowOnes = async () => { await Bun.sleep(30); return { latest: "1.0.1" }; };
    const done = await refreshRadar(app.db, repo.id, pins, slowOnes, new Date(), 50);
    expect(done).toBeLessThan(20);
  });
});

describe("the page", () => {
  const sign = (id: string, name: string, role: string) => {
    const said = `${id}|${name}|${role}|${Date.now() + 60_000}`;
    return { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
  };
  const url = () => `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;

  test("answers for an admin with the action and a tab in the header; a cross-origin POST is refused and changes nothing", async () => {
    const headers = sign("u1", "trevato", "admin");
    const res = await fetch(url(), { headers });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Flows in");
    expect(text).toContain("Flows out");
    expect(text).toContain("Read upstream releases now");
    expect(text).toContain(`href="/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows"`);
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    const before = app.db.query("SELECT * FROM dep_latest WHERE repo_id = ? ORDER BY name").all(repo.id);
    const post = await fetch(`${url()}/check`, { method: "POST", redirect: "manual", headers: { ...headers, origin: "https://evil.example" } });
    expect(post.status).toBe(403);
    expect(app.db.query("SELECT * FROM dep_latest WHERE repo_id = ? ORDER BY name").all(repo.id)).toEqual(before);
  });

  test("a private repository is hidden from a guest", async () => {
    const repo = getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
    app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?").run(repo.id);
    try {
      const guest = await fetch(url());
      expect(guest.status).toBe(404);
      expect(await guest.text()).not.toContain("Flows in");
    } finally {
      app.db.query("UPDATE repo SET visibility = 'public' WHERE id = ?").run(repo.id);
    }
  });
});

describe("link health and actions (#9561)", () => {
  const repoNow = () => getRepo(app.db, PREVIEW_ADMIN, PREVIEW_REPO)!;
  const admin = () => getUserById(app.db, app.db.query<{ id: string }, [string]>("SELECT id FROM user WHERE username = ?").get(PREVIEW_ADMIN)!.id)!;
  const now = Date.parse("2026-11-08T12:00:00Z");

  test("followHealth names each standing", () => {
    const at = "2026-11-08T11:50:00Z";
    expect(followHealth({ enabled: false, checkedAt: at, behind: 3, error: "" }, now)).toBe("off");
    expect(followHealth({ enabled: true, checkedAt: at, behind: 0, error: "x" }, now)).toBe("unread");
    expect(followHealth({ enabled: true, checkedAt: null, behind: 0, error: "" }, now)).toBe("stale");
    expect(followHealth({ enabled: true, checkedAt: "2026-11-08T06:00:00Z", behind: 0, error: "" }, now)).toBe("stale");
    expect(followHealth({ enabled: true, checkedAt: at, behind: 2, error: "" }, now)).toBe("behind");
    expect(followHealth({ enabled: true, checkedAt: at, behind: 0, error: "" }, now)).toBe("ok");
  });

  test("a mirror behind its origin shows news and Pull in what's new, for a writer only", () => {
    const repo = repoNow();
    const mirrored = { ...repo, origin: { ...(repo.origin ?? {}), originId: "o9" } } as typeof repo;
    app.db.exec("PRAGMA foreign_keys = OFF");
    app.db.query("INSERT OR REPLACE INTO origin_cursor (origin_id, key, value) VALUES ('o9', ?1, ?2)").run(`repo:${repo.id}:ahead`, `3 ${"a".repeat(40)} 0 2026-11-08T11:00:00Z`);
    const mine = readFlows(app.db, mirrored, admin(), now).inbound.find((l) => l.label === "its origin")!;
    expect(mine.health).toBe("behind");
    expect(mine.action).toEqual({ label: "Pull in what's new", href: `/${PREVIEW_ADMIN}/${PREVIEW_REPO}/sync/take`, post: true });
    const guest = readFlows(app.db, mirrored, undefined, now).inbound.find((l) => l.label === "its origin")!;
    expect(guest.health).toBe("behind");
    expect(guest.action).toBeUndefined();
    app.db.query(`UPDATE origin_cursor SET value = ?1 WHERE origin_id = 'o9'`).run(`3 ${"a".repeat(40)} 1 2026-11-08T11:00:00Z`);
    const diverged = readFlows(app.db, mirrored, admin(), now).inbound.find((l) => l.label === "its origin")!;
    expect(diverged.health).toBe("diverged");
    expect(diverged.action).toBeUndefined();
    app.db.query("DELETE FROM origin_cursor WHERE origin_id = 'o9'").run();
    app.db.exec("PRAGMA foreign_keys = ON");
  });

  test("the probe is admin only and a cross-origin POST changes nothing", async () => {
    const repo = repoNow();
    const stranger = { ...admin(), id: "nobody", isAdmin: false } as User;
    expect(await probeLinks(app, repo, stranger)).toEqual({ ok: false, why: "Only an admin of this repository can do this." });
    expect(await probeLinks(app, repo, undefined)).toMatchObject({ ok: false });
    const said = `u1|trevato|admin|${Date.now() + 60_000}`;
    const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
    const url = `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;
    const page = await (await fetch(url, { headers })).text();
    expect(page).toContain("Compare heads now");
    const post = await fetch(`${url}/probe`, { method: "POST", redirect: "manual", headers: { ...headers, origin: "https://evil.example" } });
    expect(post.status).toBe(403);
  });

  test("a fork's writer is offered a pull to its parent; a guest is not", async () => {
    const parent = repoNow();
    const made = await createRepo(app, admin(), { name: "kid", owner: PREVIEW_ADMIN, visibility: "public", description: "" });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    app.db.query("UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2").run(parent.id, made.value.id);
    const fork = getRepo(app.db, PREVIEW_ADMIN, "kid")!;
    const mine = readFlows(app.db, fork, admin(), now).inbound.find((l) => l.state === "forked from")!;
    expect(mine.label).toBe(`${PREVIEW_ADMIN}/${PREVIEW_REPO}`);
    expect(mine.action).toEqual({ label: `Offer what's useful to ${PREVIEW_ADMIN}/${PREVIEW_REPO}`, href: `/${PREVIEW_ADMIN}/kid/pulls/new`, post: false });
    expect(readFlows(app.db, fork, undefined, now).inbound.find((l) => l.state === "forked from")!.action).toBeUndefined();
    const agent = { ...admin(), kind: "agent" } as User;
    expect(readFlows(app.db, fork, agent, now).inbound.find((l) => l.state === "forked from")!.action).toBeUndefined();
  });

  test("an origin line is ok when read lately, stale when read long ago, not read yet when never", () => {
    const repo = repoNow();
    const mirrored = { ...repo, origin: { ...(repo.origin ?? {}), originId: "o8" } } as typeof repo;
    const line = () => readFlows(app.db, mirrored, undefined, now).inbound.find((l) => l.label === "its origin")!;
    expect([line().health, line().state]).toEqual(["stale", "not read yet"]);
    app.db.exec("PRAGMA foreign_keys = OFF");
    const put = (at: string) => app.db.query("INSERT OR REPLACE INTO origin_cursor (origin_id, key, value) VALUES ('o8', ?1, ?2)").run(`repo:${repo.id}:ahead-read`, at);
    put("2026-11-08T11:50:00Z");
    expect([line().health, line().state]).toEqual(["ok", "up to date"]);
    put("2026-11-08T06:00:00Z");
    expect([line().health, line().state]).toEqual(["stale", "not read lately"]);
    app.db.query("DELETE FROM origin_cursor WHERE origin_id = 'o8'").run();
    app.db.exec("PRAGMA foreign_keys = ON");
  });

  describe("the probe", () => {
    const reads = (log: string[], over: Partial<Reads> = {}): Reads => ({
      origin: async () => (log.push("origin"), true),
      upstream: async () => (log.push("upstream"), true),
      source: async (_a, _r, s) => (log.push(`source:${s.id}`), true),
      ...over,
    });
    const limiter = (n: number) => new RateLimiter({ perMinute: n, adminPerMinute: n, enabled: true });
    const addSources = (repoId: string, n: number) => {
      for (let i = 0; i < n; i++)
        app.db.query("INSERT OR IGNORE INTO repo_source (id, repo_id, url, branch, by_id, enabled, created_at) VALUES (?1, ?2, 'https://example.com/p.git', 'main', 'u1', 1, '2026-11-03T00:00:00Z')").run(`p${i}`, repoId);
    };

    test("a successful probe reads the enabled sources and announces itself", async () => {
      const repo = repoNow();
      addSources(repo.id, 2);
      const log: string[] = [];
      const seen: string[] = [];
      const off = app.bus.subscribe((e) => seen.push(e.kind));
      const out = await probeLinks(app, repo, admin(), limiter(4), reads(log));
      off();
      expect(out.ok).toBe(true);
      expect(log).toContain("source:p0");
      expect(log).toContain("source:s1");
      expect(seen).toContain("repo.links_probed");
    });

    test("an agent is refused and reads nothing", async () => {
      const log: string[] = [];
      const agent = { ...admin(), kind: "agent" } as User;
      expect(await probeLinks(app, repoNow(), agent, limiter(4), reads(log))).toEqual({ ok: false, why: "Only an admin of this repository can do this." });
      expect(log).toEqual([]);
    });

    test("one at a time, and four a minute", async () => {
      const repo = repoNow();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const slow = reads([], { source: async () => { await gate; return true; } });
      const lim = limiter(4);
      const first = probeLinks(app, repo, admin(), lim, slow);
      await Promise.resolve();
      expect(await probeLinks(app, repo, admin(), lim, slow)).toEqual({ ok: false, why: "A comparison is already running for this repository." });
      release();
      expect((await first).ok).toBe(true);
      const tight = limiter(1);
      await probeLinks(app, repo, admin(), tight, reads([]));
      const third = await probeLinks(app, repo, admin(), tight, reads([]));
      expect(!third.ok && third.why).toMatch(/^Too many comparisons/);
    });

    test("it is capped in sources and bounded in time", async () => {
      const repo = repoNow();
      addSources(repo.id, 12);
      const log: string[] = [];
      await probeLinks(app, repo, admin(), limiter(4), reads(log));
      expect(log.filter((l) => l.startsWith("source:")).length).toBeLessThanOrEqual(MAX_SOURCES);
      const hang = reads([], { source: () => new Promise<boolean>(() => {}) });
      const t0 = Date.now();
      const out = await probeLinks(app, repo, admin(), limiter(4), hang, 60);
      expect(out.ok).toBe(true);
      expect(Date.now() - t0).toBeLessThan(2000);
    });

    test("a failing read does not stop the others", async () => {
      const repo = repoNow();
      const log: string[] = [];
      const out = await probeLinks(app, repo, admin(), limiter(4), reads(log, { upstream: async () => { throw new Error("boom"); } }));
      expect(out.ok).toBe(true);
      expect(log.some((l) => l.startsWith("source:"))).toBe(true);
    });

    test("the route flashes the result for an admin", async () => {
      const said = `u1|trevato|admin|${Date.now() + 60_000}`;
      const headers = { "x-forge-identity": said, "x-forge-signature": createHmac("sha256", KEY).update(said).digest("base64url") };
      const url = `${servers.url}/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`;
      const post = await fetch(`${url}/probe`, { method: "POST", redirect: "manual", headers: { ...headers, origin: servers.url } });
      expect(post.status).toBe(303);
      expect(post.headers.get("location")).toBe(`/${PREVIEW_ADMIN}/${PREVIEW_REPO}/flows`);
    });
  });
});
