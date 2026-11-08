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
import { startRadar } from "../src/flows/start.ts";
import { plainUrl, readFlows } from "../src/flows/view.ts";
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
