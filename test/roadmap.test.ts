/** The roadmap (#10303): pillars in order, folding, the ETA from a known rate, needs-you, the live region. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { setHold } from "../src/core/holds.ts";
import { createIssue, getIssue, setIssueState, type Issue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { promote } from "./helpers/members.ts";
import { createUser, type User } from "../src/core/users.ts";
import { secureFor } from "../src/http/cookie_secure.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { etaDays, paceSentence, roadmapOf } from "../src/web/roadmap.ts";
import { lastLooked } from "../src/web/pages/map.ts";

describe("the roadmap", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let rw: string;
  let repo: Awaited<ReturnType<typeof makeRepo>>;
  const makeRepo = async () => {
    const made = await createRepo(app, alice, { name: "forge", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const open = (title: string): Issue => {
    const made = createIssue(app.db, { repoId: repo.id, authorId: alice.id, title, body: "" });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const wait = (blocked: Issue, blocker: Issue) => {
    if (!addDependency(app.db, blocked, blocker, alice.id).ok) throw new Error("dep");
  };
  let p0: Issue, p1: Issue, p2: Issue, a: Issue, b: Issue, c: Issue;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-roadmap-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const u = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    alice = u.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    repo = await makeRepo();
    p1 = open("P1 Feed: one front door");
    p0 = open("P0 Trust: agents contained");
    p2 = open("P2 Cloud: somewhere else");
    a = open("Done work");
    b = open("Startable work");
    c = open("Follow-up work");
    wait(p0, a);
    wait(p0, b);
    wait(p0, c);
    wait(c, b);
    setIssueState(app.db, a.id, "closed");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("the ETA is the open work over the seven-day rate, none without a rate", () => {
    expect(etaDays(6, 3)).toBe(14);
    expect(etaDays(1, 7)).toBe(1);
    expect(etaDays(5, 0)).toBeNull();
    expect(etaDays(0, 4)).toBeNull();
  });

  test("pillars come in order by number; the first with open work is current; the next startable is named", () => {
    const road = roadmapOf(app.db, repo, alice)!;
    expect(road.pillars.map((p) => p.short)).toEqual(["P0", "P1", "P2"]);
    expect(road.pillars.map((p) => p.state)).toEqual(["current", "future", "future"]);
    const cur = road.pillars[0]!;
    expect([cur.done, cur.total]).toEqual([1, 3]);
    expect(cur.next?.title).toBe("Startable work");
    expect(cur.lastLanding?.title).toBe("Done work");
    expect(cur.groups.blocked.map((i) => i.title)).toEqual(["Follow-up work"]);
    expect(cur.groups.blocked[0]!.blockedBy?.title).toBe("Startable work");
    expect(cur.groups.doneThisWeek.map((i) => i.title)).toEqual(["Done work"]);
    expect(road.pace.current).toBe("P0 Trust");
    expect(road.pace.etaDays).toBeNull();
  });

  test("a pillar with nothing in front of it needs the owner, and stops needing him once it has work", () => {
    expect(roadmapOf(app.db, repo, alice)!.needsYou.map((n) => n.number)).toEqual(
      expect.arrayContaining([p1.number, p2.number]),
    );
    wait(p1, open("Feed work"));
    wait(p2, open("Cloud work"));
    expect(roadmapOf(app.db, repo, alice)!.needsYou).toEqual([]);
  });

  test("a finished pillar folds to done and the next becomes current", () => {
    setIssueState(app.db, b.id, "closed");
    setIssueState(app.db, c.id, "closed");
    const road = roadmapOf(app.db, repo, alice)!;
    expect(road.pillars.map((p) => p.state)).toEqual(["done", "current", "future"]);
    expect(road.pace.current).toBe("P1 Feed");
  });

  test("the page draws it folded, the API and the graph view answer, and moves mark since the last visit", async () => {
    const headers = { authorization: `Bearer ${rw}` };
    const page = await (await fetch(`${servers.url}/alice/forge/map`, { headers })).text();
    expect(page).toContain('id="roadmap-live"');
    expect(page).toContain("data-live=");
    expect(page).toMatch(/<details id="pillar-p0-fold"\s*>/);
    expect(page).toMatch(/<details id="pillar-p1-fold"\s+open/);
    expect(page.indexOf("pillar-p0")).toBeLessThan(page.indexOf("pillar-p1"));
    expect(page.indexOf("pillar-p1")).toBeLessThan(page.indexOf("pillar-p2"));
    const api = (await (await fetch(`${servers.url}/api/v1/repos/alice/forge/roadmap`, { headers })).json()) as any;
    expect(api.pillars.map((p: any) => p.short)).toEqual(["P0", "P1", "P2"]);
    const graph = await (await fetch(`${servers.url}/alice/forge/map?view=graph`, { headers })).text();
    expect(graph).not.toContain('id="roadmap-live"');
    // The live update: a landing changes the rows the next fetch of the page draws.
    const before = await (await fetch(`${servers.url}/alice/forge/map`, { headers })).text();
    const feedWork = roadmapOf(app.db, repo, alice)!.pillars[1]!.groups.upNext[0]!;
    setIssueState(app.db, getIssue(app.db, repo.id, feedWork.number)!.id, "closed");
    const after = await (await fetch(`${servers.url}/alice/forge/map`, { headers })).text();
    expect(after).not.toBe(before);
    expect(after).toMatch(/id="pillar-p1"[^>]*data-pillar="done"/);
    expect(before).toMatch(/id="pillar-p1"[^>]*data-pillar="current"/);
  });

  test("lastLooked keeps the previous visit across a live fetch and rolls it over after half an hour", () => {
    const t0 = new Date("2026-11-09T10:00:00.000Z");
    const first = lastLooked(undefined, t0, true);
    expect(first.since).toBeUndefined();
    expect(first.cookie).toBe(`~${t0.toISOString()}`);
    const later = new Date(t0.getTime() + 3_600_000);
    const second = lastLooked(first.cookie, later, true);
    expect(second.since).toBe(t0.toISOString());
    const fetched = lastLooked(second.cookie, later, false);
    expect(fetched.since).toBe(t0.toISOString());
    expect(fetched.cookie).toBeUndefined();
    expect(lastLooked("junk~also", t0, true).since).toBeUndefined();
  });

  test("the pace is plain sentences: a date where there is a rate, 'no date yet' where there is none", () => {
    const road = roadmapOf(app.db, repo, alice, { now: new Date("2026-11-09T00:00:00Z") })!;
    expect(paceSentence(road)).toBe("Landed 0 today and 0 in 7 days. P2 Cloud has no date yet.");
    const rated = { ...road, pace: { ...road.pace, etaDays: 11, etaAt: "2026-11-20T00:00:00.000Z" } };
    expect(paceSentence(rated)).toContain("P2 Cloud finishes around Nov 20.");
    expect(paceSentence({ ...road, pace: { ...road.pace, current: null } })).toContain("Every pillar is done.");
  });

  describe("on a public repository with a held pull and a sealed one", () => {
    let pub: Awaited<ReturnType<typeof makeRepo>>;
    let carol: User;
    let held: Issue;
    beforeAll(async () => {
      const mk = async (name: string) => {
        const made = await createRepo(app, alice, { name, visibility: "public" });
        if (!made.ok) throw new Error(String(made.error));
        return made.value;
      };
      pub = await mk("pub");
      await mk("plain");
      const c = await createUser(app.db, {
        origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase",
      });
      if (!c.ok) throw new Error(c.error);
      carol = c.value;
      promote(app.db, carol);
      const mkIssue = (title: string, extra: { kind?: "pull"; sealed?: boolean } = {}): Issue => {
        const made = createIssue(app.db, { repoId: pub.id, authorId: alice.id, title, body: "", ...extra });
        if (!made.ok) throw new Error(made.error);
        return made.value;
      };
      const umbrella = mkIssue("P0 Trust: contained");
      const work = mkIssue("Public work");
      wait(umbrella, work);
      held = mkIssue("Visible pull", { kind: "pull" });
      setHold(app.db, held.id, alice.id, "second look");
      const sealed = mkIssue("Sealed pull secret-title", { kind: "pull", sealed: true });
      setHold(app.db, sealed.id, alice.id, "sealed why");
    });

    test("a writer is told about a held pull", () => {
      const road = roadmapOf(app.db, pub, alice)!;
      expect(road.needsYou.map((n) => n.number)).toContain(held.number);
      expect(road.needsYou.find((n) => n.number === held.number)).toMatchObject({ kind: "hold", pull: true });
    });

    test("a guest and a reader get no Needs you and never a sealed title", () => {
      for (const reader of [undefined, carol]) {
        const road = roadmapOf(app.db, pub, reader)!;
        expect(road.needsYou).toEqual([]);
        expect(JSON.stringify(road)).not.toContain("secret-title");
      }
    });

    test("the API answers a guest on a public repository and 404s one without pillars", async () => {
      const ok = await fetch(`${servers.url}/api/v1/repos/alice/pub/roadmap`);
      expect(ok.status).toBe(200);
      const body = await ok.text();
      expect(body).not.toContain("secret-title");
      expect(JSON.parse(body).needsYou).toEqual([]);
      expect((await fetch(`${servers.url}/api/v1/repos/alice/plain/roadmap`)).status).toBe(404);
    });

    test("MCP map with roadmap: true returns the model; an app without pillars says so", async () => {
      const call = async (app_: string) => {
        const res = await fetch(`${servers.url}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rw}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "map", arguments: { app: app_, roadmap: true } } }),
        });
        return (await res.json()) as any;
      };
      const good = await call("alice/pub");
      expect(good.result.isError).not.toBe(true);
      expect(JSON.parse(good.result.content[0].text).pillars[0].short).toBe("P0");
      const none = await call("alice/plain");
      expect(none.result.isError).toBe(true);
      expect(none.result.content[0].text).toContain("no pillars");
    });

    test("the default map of a repository without pillars still draws the graph", async () => {
      const page = await (await fetch(`${servers.url}/alice/plain/map`)).text();
      expect(page).not.toContain('id="roadmap-live"');
      expect(page).toContain("map-svg");
    });

    test("the last-looked cookie is HttpOnly and named for the repository; not Secure over http", async () => {
      const res = await fetch(`${servers.url}/alice/pub/map`);
      const cookie = res.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/^rm_alice_pub=~\d{4}-/);
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).not.toContain("Secure");
      expect(secureFor(new URL("https://forge.example/"), undefined)).toBe(true);
      // A live fetch (not a navigation) never sets it.
      const live = await fetch(`${servers.url}/alice/pub/map`, { headers: { "sec-fetch-mode": "cors" } });
      expect(live.headers.get("set-cookie")).toBeNull();
    });
  });
});
