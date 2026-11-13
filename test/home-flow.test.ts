/**
 * The new home (`/home`, web/pages/home_flow.ts): the pipeline as six live
 * lanes. It draws for an owner with work in every lane, a change shows up in
 * the lane its event puts it in, a viewer is never shown what they may not
 * read, the lane's health says stuck when it is, and nothing on the page or
 * in its script polls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { laneHealth, lanePicture, LANES, viewFor, type LaneKey, type LaneView } from "../src/flow/lanes.ts";
import { promote } from "./helpers/members.ts";
import { seedHomeFlow, startCheck, type HomeFlowSeed } from "./helpers/home-flow-seed.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let seed: HomeFlowSeed;
let owner = "";
let bob = "";

const get = (path: string, cookie: string) => fetch(`${servers.url}${path}`, { headers: { cookie }, redirect: "manual" });
const titles = (html: string, lane: LaneKey): string[] => {
  const region = html.split(`id="lane-${lane}"`)[1]?.split("</section>")[0] ?? "";
  return [...region.matchAll(/class="tile-title">([^<]*)</g)].map((m) => m[1]!.replaceAll("&#39;", "'"));
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-home-flow-"));
  app = createApp({ dataDir, port: 0 });
  seed = await seedHomeFlow(app);
  servers = await serve(app);
  owner = `forge_session=${createSession(app.db, seed.owner.id).token}`;
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  promote(app.db, made.value);
  bob = `forge_session=${createSession(app.db, made.value.id).token}`;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe("the new home draws every lane", () => {
  test("an owner with work in every stage sees each item in its own lane", async () => {
    const res = await get("/home", owner);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const lane of LANES) expect(html).toContain(`id="lane-${lane}"`);
    expect(titles(html, "asked")).toContain("Tell the owner in words why a build is waiting");
    expect(titles(html, "building")).toContain("A cost ledger per delivery: tokens, compute and time");
    expect(titles(html, "checks")).toContain("The pipeline page tells a stuck lane from a busy one");
    expect(titles(html, "review")).toContain("Show a hosted forge's state in one line");
    expect(titles(html, "landing")).toEqual(expect.arrayContaining(["A failed proof is the one line that needs you", "Search finds a note by its day"]));
    expect(titles(html, "live")).toContain("The merge queue says why it is waiting");
    // a lane never holds another lane's work
    expect(titles(html, "checks")).not.toContain("Show a hosted forge's state in one line");
    // the strip, the hosted forges line, and the way back
    expect(html).toContain('id="hf-strip"');
    expect(html).toContain('id="hf-forges"');
    expect(html).toContain("/?home=classic");
  });

  test("each lane is its own live region with its own address, so one event redraws one lane", async () => {
    const html = await (await get("/home", owner)).text();
    for (const lane of LANES) {
      const tag = html.match(new RegExp(`<section[^>]*id="lane-${lane}"[^>]*>`))?.[0] ?? "";
      expect(tag).toContain("data-live=");
      expect(tag).toContain(`data-live-src="/live/lane?s=${lane}"`);
    }
    const lane = await get("/live/lane?s=building", owner);
    expect(lane.status).toBe(200);
    expect(lane.headers.get("etag")).not.toBeNull();
    expect(lane.headers.get("server-timing")).toContain("picture");
    const body = await lane.text();
    expect(body).toContain('id="lane-building"');
    expect(body).not.toContain('id="lane-checks"');
    // a lane that has not changed answers 304
    const again = await fetch(`${servers.url}/live/lane?s=building`, { headers: { cookie: owner, "if-none-match": lane.headers.get("etag")! } });
    expect(again.status).toBe(304);
    expect((await get("/live/lane?s=nonsense", owner)).status).toBe(404);
  });

  test("a change shows up in the lane its event puts it in, and leaves the one it was in", async () => {
    const before = await (await get("/live/lane?s=checks", owner)).text();
    const landingBefore = await (await get("/live/lane?s=landing", owner)).text();
    expect(titles(before, "checks")).not.toContain("Pasted links keep their address");
    expect(titles(landingBefore, "landing")).toContain("Pasted links keep their address");
    // the crew starts the checks on an approved pull: its approval is superseded by new work, a check begins
    const pull = seed.pulls["a2"]!;
    app.db.run("UPDATE review SET state = 'commented' WHERE issue_id = ?1", [pull]);
    startCheck(app, pull, seed.repos.glue.id);
    app.bus.append({ kind: "run.started", repoId: seed.repos.glue.id, payload: {} });
    const after = await (await get("/live/lane?s=checks", owner)).text();
    const landingAfter = await (await get("/live/lane?s=landing", owner)).text();
    expect(titles(after, "checks")).toContain("Pasted links keep their address");
    expect(titles(landingAfter, "landing")).not.toContain("Pasted links keep their address");
    // the tile keeps its key across lanes: the page moves it instead of drawing a new one
    const key = after.split('<li class="tile"').find((c) => c.includes("Pasted links keep"))?.match(/data-key="([^"]+)"/)?.[1];
    expect(key).toBeDefined();
    expect(landingBefore).toContain(`data-key="${key}"`);
  });

  test("a viewer sees only what they may read, and the lane's count is theirs", async () => {
    const html = await (await get("/home", bob)).text();
    // glue is private: nothing of it is named
    expect(html).not.toContain("Retry a failed webhook");
    expect(html).not.toContain("Pasted links");
    expect(titles(html, "building")).toContain("A cost ledger per delivery: tokens, compute and time");
    // the owner-only strip and fragments are not his
    expect(html).not.toContain('id="hf-strip"');
    expect((await get("/live/strip", bob)).status).toBe(403);
    // signed out: sign in first
    const out = await fetch(`${servers.url}/home`, { redirect: "manual" });
    expect(out.status).toBe(303);
    expect(out.headers.get("location")).toContain("/signin");
  });

  test("the filter shows one app, and its lanes listen only for that app's events", async () => {
    const html = await (await get("/home?app=trevato/notes", owner)).text();
    expect(titles(html, "building")).toEqual(["Keep a draft when the page is closed by accident"]);
    expect(html).toContain('data-live-repo="trevato/notes"');
    expect(html).toContain("/live/lane?s=building&amp;app=trevato%2Fnotes");
    // a filter that is no app is no filter
    const odd = await (await get("/home?app=../../etc", owner)).text();
    expect(titles(odd, "building").length).toBeGreaterThan(1);
  });
});

describe("a lane says its health in words", () => {
  const view = (key: LaneKey, items: Partial<LaneView["items"][number]>[], total = items.length): LaneView => ({
    key,
    total,
    more: 0,
    items: items.map((i, n) => ({ key: `k${n}`, repoId: "r", kind: "issue", number: n + 1, title: "t", sealed: false, who: "", since: new Date(now - 60_000).toISOString(), state: "active", hint: "", position: null, beat: null, more: 0, repo: "o/r", href: "/", ...i })),
  });
  const now = Date.now();
  const input = { now, builders: { running: 1, slots: 4 } };

  test("a builder that has gone quiet is stuck, with its reason", () => {
    const quiet = new Date(now - 20 * 60_000).toISOString();
    const h = laneHealth(view("building", [{ beat: quiet }]), undefined, input);
    expect(h.tone).toBe("stuck");
    expect(h.words).toContain("gone quiet");
  });

  test("builders working with nothing waiting are flowing; a queue is waiting; an empty lane is quiet", () => {
    expect(laneHealth(view("building", [{}, {}]), undefined, input).tone).toBe("flowing");
    expect(laneHealth(view("building", [{}, { state: "waiting" }]), undefined, input).tone).toBe("waiting");
    expect(laneHealth(view("building", []), undefined, input).tone).toBe("quiet");
  });

  test("an item that waits past half an hour for a worker is stuck, and the oldest's age is named", () => {
    const long = new Date(now - 50 * 60_000).toISOString();
    const h = laneHealth(view("checks", [{ state: "waiting", since: long }]), undefined, input);
    expect(h.tone).toBe("stuck");
    expect(h.oldest).toBe("50m");
  });

  test("approved changes wait on the owner, and say so", () => {
    const h = laneHealth(view("landing", [{ state: "waiting", since: new Date(now - 3_600_000).toISOString() }]), undefined, input);
    expect(h.tone).toBe("waiting");
    expect(h.words).toContain("for you");
  });
});

describe("the picture is read once per write", () => {
  test("two readers share it until something is written", () => {
    const a = lanePicture(app.db);
    expect(lanePicture(app.db)).toBe(a);
    app.db.run("UPDATE issue SET title = title WHERE id = ?1", [Object.values(seed.issues)[0]!]);
    expect(lanePicture(app.db)).not.toBe(a);
  });

  test("a private repository's work is filtered by the viewer, never by the page", () => {
    const picture = lanePicture(app.db);
    const asBob = viewFor(app.db, { ...seed.owner, id: "x", isAdmin: false } as typeof seed.owner, picture);
    expect(asBob.repos).not.toContain("trevato/glue");
  });
});

describe("nothing on the new home polls", () => {
  test("neither the page nor its script sets an interval or a timer", () => {
    for (const file of ["src/web/pages/home_flow.ts", "src/web/pages/home_flow_client.ts", "src/flow/lanes.ts"]) {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(text).not.toMatch(/setInterval\s*\(/);
      expect(text).not.toMatch(/setTimeout\s*\(/);
      expect(text).not.toMatch(/requestAnimationFrame/);
    }
  });

  test("it honours a reader who asked for less motion", () => {
    const client = readFileSync(join(import.meta.dir, "..", "src/web/pages/home_flow_client.ts"), "utf8");
    const style = readFileSync(join(import.meta.dir, "..", "src/web/pages/home_flow_style.ts"), "utf8");
    expect(client).toContain("prefers-reduced-motion");
    expect(style).toContain("prefers-reduced-motion");
  });
});
