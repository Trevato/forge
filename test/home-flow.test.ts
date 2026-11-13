/**
 * The home (`/`, web/pages/home_flow.ts): the pipeline as six live
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
import { laneHealth, lanePicture, LANES, warmLanes, readLanesInline, viewFor, type LaneItem, type LaneKey, type LanePicture, type LaneView } from "../src/flow/lanes.ts";
import type { LaneAnswer, LaneJob } from "../src/flow/lanes_worker.ts";
import { promote } from "./helpers/members.ts";
import { seedHomeFlow, startCheck, type HomeFlowSeed } from "./helpers/home-flow-seed.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let seed: HomeFlowSeed;
let owner = "";
let bob = "";

const post = (path: string, cookie: string, body: URLSearchParams) => fetch(`${servers.url}${path}`, { method: "POST", body, headers: { cookie, origin: servers.url, accept: "application/json" }, redirect: "manual" });
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
    const res = await get("/", owner);
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
    expect(html).not.toContain("classic");
    expect(html).not.toContain("Try the new home");
  });

  test("each lane is its own live region with its own address, so one event redraws one lane", async () => {
    const html = await (await get("/", owner)).text();
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
    const html = await (await get("/", bob)).text();
    // glue is private: nothing of it is named
    expect(html).not.toContain("Retry a failed webhook");
    expect(html).not.toContain("Pasted links");
    expect(titles(html, "building")).toContain("A cost ledger per delivery: tokens, compute and time");
    // the owner-only strip and fragments are not his
    // the line that needs him, never the owner's figures
    expect(html).not.toContain("hf-figs");
    expect(html).not.toContain('id="hf-figures"');
    expect((await get("/live/figures", bob)).status).toBe(403);
    expect(await (await get("/live/strip", bob)).text()).not.toContain("hf-figs");
    // signed out, `/` is the public door and nothing of the pipeline
    const door = await fetch(`${servers.url}/`, { redirect: "manual" });
    expect(door.status).toBe(200);
    expect(await door.text()).not.toContain('id="lane-building"');
  });

  test("the filter shows one app, and its lanes listen only for that app's events", async () => {
    const html = await (await get("/?app=trevato/notes", owner)).text();
    expect(titles(html, "building")).toEqual(["Keep a draft when the page is closed by accident"]);
    expect(html).toContain('data-live-repo="trevato/notes"');
    expect(html).toContain("/live/lane?s=building&amp;app=trevato%2Fnotes");
    // a filter that is no app is no filter
    const odd = await (await get("/?app=../../etc", owner)).text();
    expect(titles(odd, "building").length).toBeGreaterThan(1);
  });
});

describe("a lane says its health in words", () => {
  const now = Date.now();
  const view = (key: LaneKey, items: Partial<LaneItem>[], total = items.length): LaneView => {
    const all = items.map((i, n) => ({ repo: "o/r", href: "/", key: `k${n}`, repoId: "r", kind: "issue", number: n + 1, title: "t", sealed: false, who: "", since: new Date(now - 60_000).toISOString(), state: "active", hint: "", position: null, beat: null, issueId: null, born: null, ...i }) satisfies LaneItem & { repo: string; href: string });
    return { key, total, more: 0, all, items: all };
  };
  const moved = { asked: 0, building: 0, checks: 0, review: 0, landing: 0, live: 0 };
  const input = { now, builders: { running: 1, slots: 4 }, moved };

  test("a builder that has gone quiet is stuck, with its reason", () => {
    const quiet = new Date(now - 20 * 60_000).toISOString();
    const h = laneHealth(view("building", [{ beat: quiet }]), input);
    expect(h.tone).toBe("stuck");
    expect(h.words).toContain("gone quiet");
  });

  test("builders working with nothing waiting are flowing; a queue is waiting; an empty lane is quiet", () => {
    expect(laneHealth(view("building", [{}, {}]), input).tone).toBe("flowing");
    expect(laneHealth(view("building", [{}, { state: "waiting" }]), input).tone).toBe("waiting");
    expect(laneHealth(view("building", []), input).tone).toBe("quiet");
  });

  test("an item that waits past half an hour while nothing starts is stuck; while something starts it is only waiting", () => {
    const long = new Date(now - 50 * 60_000).toISOString();
    const h = laneHealth(view("checks", [{ state: "waiting", since: long }]), input);
    expect(h.tone).toBe("stuck");
    expect(h.oldest).toBe("50m");
    expect(laneHealth(view("checks", [{ state: "waiting", since: long }]), { ...input, moved: { ...moved, checks: 3 } }).tone).toBe("waiting");
  });

  test("a backlog of old asks is not stuck while the crew is taking them, and is when a builder is free and none starts", () => {
    const old = new Date(now - 39 * 86_400_000).toISOString();
    const asks = view("asked", [{ state: "waiting", since: old }], 40);
    expect(laneHealth(asks, { ...input, moved: { ...moved, asked: 4 } }).tone).toBe("flowing");
    expect(laneHealth(asks, { ...input, builders: { running: 4, slots: 4 } }).tone).toBe("waiting");
    const none = laneHealth(asks, input);
    expect(none.tone).toBe("stuck");
    // the age of the backlog is never the reason, and never in the words
    expect(laneHealth(asks, { ...input, moved: { ...moved, asked: 4 } }).words).not.toContain("39d");
  });

  test("approved changes wait on the owner, and say so; they are stuck only when nothing has landed for days", () => {
    const hour = laneHealth(view("landing", [{ state: "waiting", since: new Date(now - 3_600_000).toISOString() }]), input);
    expect(hour.tone).toBe("waiting");
    expect(hour.words).toContain("for you");
    const week = new Date(now - 7 * 86_400_000).toISOString();
    expect(laneHealth(view("landing", [{ state: "waiting", since: week }]), input).tone).toBe("stuck");
    expect(laneHealth(view("landing", [{ state: "waiting", since: week }]), { ...input, moved: { ...moved, landing: 2 } }).tone).toBe("waiting");
  });
});

describe("the picture is read off the thread, once per write", () => {
  const options = () => ({ dataDir, ceilingUsd: null });
  const read = async (): Promise<LanePicture> => {
    const got = await lanePicture(app.db, options());
    if (got === undefined) throw new Error("no picture");
    return got;
  };

  test("two readers share it until something is written", async () => {
    const a = await read();
    expect(await read()).toBe(a);
    app.db.run("UPDATE issue SET title = title WHERE id = ?1", [Object.values(seed.issues)[0]!]);
    expect(await read()).not.toBe(a);
  });

  test("a lane's version moves with what the lane shows and with nothing else", async () => {
    const a = await read();
    app.db.run("UPDATE issue SET title = title WHERE id = ?1", [Object.values(seed.issues)[0]!]);
    const b = await read();
    expect(b.versions).toEqual(a.versions);
    startCheck(app, seed.pulls["r2"]!, seed.repos.notes.id);
    const c = await read();
    expect(c.versions.checks).not.toBe(b.versions.checks);
    expect(c.versions.live).toBe(b.versions.live);
  });

  test("the worker reads the same picture on a handle of its own", async () => {
    const worker = new Worker(new URL("../src/flow/lanes_worker.ts", import.meta.url).href);
    try {
      const answer = await new Promise<LaneAnswer>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<LaneAnswer>) => resolve(e.data);
        worker.onerror = (e) => reject(new Error(String(e.message)));
        worker.postMessage({ id: 1, path: app.db.filename, now: Date.now(), stamp: undefined, dataDir, ceilingUsd: null, viewers: [] } satisfies LaneJob);
      });
      expect(answer.error).toBeUndefined();
      const inline = readLanesInline(app.db, options());
      expect(answer.picture?.lanes.building.items.map((i) => i.title)).toEqual(inline.lanes.building.items.map((i) => i.title));
      expect(answer.picture?.lanes.asked.total).toBe(inline.lanes.asked.total);
      // the fast part is a few indexed reads
      expect(answer.fastMs ?? 1e9).toBeLessThan(500);
    } finally {
      worker.terminate();
    }
  });

  test("the asked lane lists the next asks in the crew's own order and counts the rest", async () => {
    const picture = await read();
    expect(picture.lanes.asked.total).toBeGreaterThanOrEqual(4);
    // an ask with a build in flight has left the lane
    expect(picture.lanes.asked.items.map((i) => i.title)).not.toContain("A cost ledger per delivery: tokens, compute and time");
  });

  test("a private repository's work is filtered by the viewer, never by the page", async () => {
    const picture = await read();
    const asBob = viewFor(app.db, { ...seed.owner, id: "x", isAdmin: false } as typeof seed.owner, picture);
    expect(asBob.repos).not.toContain("trevato/glue");
  });
});

describe("nothing on the new home polls", () => {
  test("neither the page nor its script sets an interval, a timer or an animation loop", () => {
    for (const file of ["src/web/pages/home_flow.ts", "src/web/pages/home_flow_client.ts", "src/flow/lanes.ts", "src/flow/lanes_read.ts", "src/flow/lanes_worker.ts"]) {
      const text = readFileSync(join(import.meta.dir, "..", file), "utf8");
      expect(text).not.toMatch(/setInterval\s*\(/);
      expect(text).not.toMatch(/requestAnimationFrame/);
      // the picture's two one-shots (a pause, a deadline on one worker job) are the only timers, and they hold nothing
      expect((text.match(/setTimeout\s*\(/g) ?? []).length).toBe(file === "src/flow/lanes.ts" ? 2 : 0);
    }
  });

  test("it honours a reader who asked for less motion", () => {
    const client = readFileSync(join(import.meta.dir, "..", "src/web/pages/home_flow_client.ts"), "utf8");
    const style = readFileSync(join(import.meta.dir, "..", "src/web/pages/home_flow_style.ts"), "utf8");
    expect(client).toContain("prefers-reduced-motion");
    expect(style).toContain("prefers-reduced-motion");
  });
});

describe("before the first reading, a page never reads on the thread", () => {
  test("it draws reading… at once, the worker fills the lanes, and the next page has them", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-home-first-"));
    const fresh = createApp({ dataDir: root, port: 0 });
    const was = process.env["NODE_ENV"];
    try {
      const s = await seedHomeFlow(fresh);
      const srv = await serve(fresh);
      const cookie = `forge_session=${createSession(fresh.db, s.owner.id).token}`;
      // outside `bun test`: the worker reads, a page does not wait for it
      process.env["NODE_ENV"] = "production";
      const first = await fetch(`${srv.url}/`, { headers: { cookie } });
      const html = await first.text();
      expect(html).toContain("data-reading");
      expect(html).toContain("Reading what the forge is doing");
      expect(html).toContain("Reading today's figures");
      expect(html).toContain("Reading the hosted forges");
      for (const lane of LANES) expect(html).toContain(`id="lane-${lane}"`);
      expect(html).not.toContain("A cost ledger per delivery");
      // its script fills each region from the region's own address: the lane waits for the worker, off the thread
      const lane = await (await fetch(`${srv.url}/live/lane?s=building`, { headers: { cookie } })).text();
      expect(lane).toContain("A cost ledger per delivery");
      expect(lane).not.toContain("data-reading");
      const forges = await (await fetch(`${srv.url}/live/forges`, { headers: { cookie } })).text();
      expect(forges).toContain("hosted forge");
      const next = await (await fetch(`${srv.url}/`, { headers: { cookie } })).text();
      expect(next).not.toContain("data-reading");
      expect(next).toContain("A cost ledger per delivery");
      srv.stop();
    } finally {
      process.env["NODE_ENV"] = was ?? "test";
      fresh.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("the forge starts the reading when it is listening, and a database with no file reads inline", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-home-warm-"));
    const fresh = createApp({ dataDir: root, port: 0 });
    const was = process.env["NODE_ENV"];
    try {
      await seedHomeFlow(fresh);
      process.env["NODE_ENV"] = "production";
      expect(await lanePicture(fresh.db, { dataDir: root, ceilingUsd: null }, "page")).toBeUndefined();
      warmLanes(fresh.db, { dataDir: root, ceilingUsd: null }, Date.now());
      const read = await lanePicture(fresh.db, { dataDir: root, ceilingUsd: null }, "lane");
      expect(read?.lanes.building.total).toBe(4);
      expect(await lanePicture(fresh.db, { dataDir: root, ceilingUsd: null }, "page")).toBe(read);
    } finally {
      process.env["NODE_ENV"] = was ?? "test";
      fresh.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the home is the root", () => {
  test("/home and /?home=new go to /, keeping the view and the filters", async () => {
    const a = await get("/home?view=table&lane=checks&state=stuck", owner);
    expect(a.status).toBe(303);
    expect(a.headers.get("location")).toBe("/?view=table&lane=checks&state=stuck");
    const b = await get("/?home=new&view=table", owner);
    expect(b.status).toBe(303);
    expect(b.headers.get("location")).toBe("/?view=table");
    expect((await get("/?home=classic", owner)).headers.get("location")).toBe("/");
    // a stranger still gets the door, and /home sends them to it
    const c = await fetch(`${servers.url}/home`, { redirect: "manual" });
    expect(c.headers.get("location")).toBe("/");
  });

  test("it carries the box that tells the crew with Notes and Talk, one line that needs the owner with the real count, and no second pipeline", async () => {
    const html = await (await get("/", owner)).text();
    expect(html).toContain('id="tell-box"');
    expect(html).toContain('href="/notes"');
    expect(html).toContain('href="/talk"');
    for (const old of ["Being built", "Just shipped", "Later gate", "Since you were here", 'id="live-moving"', 'id="now-line"', 'id="needs-you"'])
      expect(html).not.toContain(old);
    expect(html.match(/hf-need|hf-calm/g)?.length).toBeLessThanOrEqual(2);
  });
});

describe("a proof that did not pass is told in words, with its own record, and red only when the release is not serving", () => {
  const proofFile = () => join(dataDir, "release", "proof.json");
  const write = async (p: Record<string, unknown>) => {
    await Bun.write(proofFile(), JSON.stringify({ version: "0.7.576", at: new Date(Date.now() - 60_000).toISOString(), ok: false, ...p }));
  };
  const RATE = "a stranger's journey failed: the forge could not be named: it sent the person somewhere else (/?start=rate&name=probe-0a9a10a2#start-f)";

  test("a stranger turned away by the sign-up limit is a notice: the release is serving, no query string, one line", async () => {
    await write({ failure: RATE, failures: 2 });
    const html = await (await get("/", owner)).text();
    const need = html.match(/<p class="hf-need"[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(need).toContain('data-tone="notice"');
    expect(need).toContain("is serving");
    expect(need).toContain("sign-up limit");
    expect(need).toContain('href="/releases#proof"');
    expect(need).not.toContain("start=rate");
    expect(need).not.toContain("probe-");
    expect(need).not.toContain('data-tone="danger"');
    expect(html.match(/class="hf-need"/g)?.length).toBe(1);
    // a person who cannot administer the forge is not told of it
    expect(await (await get("/", bob)).text()).not.toContain("sign-up limit");
  });

  test("a public address that did not answer as the release is red, and says it is not serving", async () => {
    await write({ failure: "https://f/a.css expected 200 (status 500)" });
    const need = (await (await get("/", owner)).text()).match(/<p class="hf-need"[\s\S]*?<\/p>/)?.[0] ?? "";
    expect(need).toContain('data-tone="alarm"');
    expect(need).toContain("is not serving as it should");
    expect(need).toContain('data-dot="danger"'.replace("data-dot", "data-tone"));
  });

  test("the releases page opens on the proof's record: where it stopped, what happened, when it tries again, and a way to try now", async () => {
    await write({ failure: RATE, failures: 3 });
    const html = await (await get("/releases", owner)).text();
    const i = html.indexOf('id="proof"');
    expect(i).toBeGreaterThan(0);
    // it is the first thing after the page head
    expect(html.slice(html.indexOf("<h1>Releases</h1>"), i)).not.toContain("<li");
    const card = html.slice(i, i + 6000);
    expect(card).toContain("The forge could not be named");
    expect(card).toContain("sign-up limit");
    expect(card).toContain("Next try");
    expect(card).toContain("Exactly what the proof saw");
    expect(card).toContain('action="/releases/prove"');
    // trying it now asks the next tick to prove it, whatever the backoff
    const res = await post("/releases/prove", owner, new URLSearchParams());
    expect(res.status).toBeLessThan(400);
    const kept = JSON.parse(await Bun.file(proofFile()).text()) as { retryNow?: boolean };
    expect(kept.retryNow).toBe(true);
    const { proofDue } = await import("../src/release/prove.ts");
    expect(proofDue({ version: "0.7.576", at: new Date().toISOString(), ok: false, failures: 9, retryNow: true } as never, "0.7.576", Date.now())).toBe(true);
    // a person who cannot administer the forge cannot
    expect((await post("/releases/prove", bob, new URLSearchParams())).status).toBeGreaterThanOrEqual(400);
    await Bun.write(proofFile(), "");
  });
});
