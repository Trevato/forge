/**
 * #5804: "Since you were here" starts at the viewer's last load of home, at
 * least an hour and at most a week back, a day on a first visit; recording
 * the visit writes at most once a minute and shows as a `visit` phase on `/`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { lastVisit, noteVisit } from "../src/core/home_visit.ts";
import { DIGEST_WINDOW_MS, headingOf, windowOf } from "../src/feed/digest.ts";
import { eventsSince } from "../src/web/studio/since.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

const H = 3600 * 1000;
const now = Date.parse("2026-10-27T12:00:00Z");

test("the window: a first visit is a day, 3 hours is 3 hours, 10 days is capped at 7, under an hour is an hour", () => {
  expect(windowOf(undefined, now)).toBe(DIGEST_WINDOW_MS);
  expect(windowOf(now - 3 * H, now)).toBe(3 * H);
  expect(windowOf(now - 10 * 24 * H, now)).toBe(7 * 24 * H);
  expect(windowOf(now - 5 * 60 * 1000, now)).toBe(H);
  expect(windowOf(now + H, now)).toBe(H);
});

test("the heading names the window", () => {
  expect(headingOf(3 * H)).toBe("Since you were here · 3 hours");
  expect(headingOf(H)).toBe("Since you were here · 1 hour");
  expect(headingOf(48 * H)).toBe("Since you were here · 2 days");
  expect(headingOf(7 * 24 * H)).toBe("Since you were here · 7 days");
});

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

test("a visit is written at most once a minute and answers the one before", () => {
  const id = f.peer.id;
  expect(noteVisit(f.app.db, id, now)).toBeUndefined();
  expect(lastVisit(f.app.db, id)).toBe(now);
  expect(noteVisit(f.app.db, id, now + 30_000)).toBe(now);
  expect(lastVisit(f.app.db, id)).toBe(now);
  expect(noteVisit(f.app.db, id, now + 61_000)).toBe(now);
  expect(lastVisit(f.app.db, id)).toBe(now + 61_000);
});

test("home heads the digest with the window, lists only landed pulls the viewer can read, and records the visit", async () => {
  const db = f.app.db;
  const pub = f.repos.find((r) => r.visibility === "public")!;
  const priv = { id: f.app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'notes'").get()!.id, name: "notes" };
  const land = (repoId: string, number: number, ago: number): void => {
    const id = `since-${repoId}-${number}`;
    db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?1, ?2, ?3, 'pull', 't', ?4)").run(id, repoId, 9000 + number, f.owner.id);
    db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', 'h', 'a', 'b', ?2)").run(id, new Date(Date.now() - ago).toISOString());
  };
  land(pub.id, 1, 2 * H);
  land(pub.id, 2, 5 * 24 * H);
  land(priv.id, 3, H);
  expect(eventsSince(db, f.peer, Date.now() - 3 * H, Date.now())).toHaveLength(2);
  expect(eventsSince(db, f.peer, Date.now() - 10 * 24 * H, Date.now())).toHaveLength(3);
  // The admin owner reads the peer's private repository too; keep it out of the owner's page below.
  db.query("DELETE FROM pull WHERE issue_id = ?1").run(`since-${priv.id}-3`);

  db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(f.owner.id, Date.now() - 3 * H);
  const res = await fetch(`${f.base}/feed?all=1`, { headers: { cookie: f.ownerCookie } });
  const text = await res.text();
  expect(text).toContain("Since you were here · 3 hours");
  expect(text).toContain("1 landed");
  expect(text).not.toContain(`/${f.owner.username}/${priv.name}/pulls/9003`);
  const visit = /visit;dur=([\d.]+)/.exec(res.headers.get("server-timing") ?? "");
  expect(visit).not.toBeNull();
  expect(Date.now() - lastVisit(db, f.owner.id)!).toBeLessThan(5000);
});

test("a first-time user, with no home_visit row, gets the 24 hour heading", async () => {
  const db = f.app.db;
  db.query("DELETE FROM home_visit WHERE user_id = ?1").run(f.owner.id);
  const text = await (await fetch(`${f.base}/feed?all=1`, { headers: { cookie: f.ownerCookie } })).text();
  expect(text).toContain("Since you were here · 1 day<");
  expect(text).toContain("1 landed");
  expect(lastVisit(db, f.owner.id)).toBeDefined();
});

test("the terminal home shows the same digest from the same row and writes nothing", async () => {
  const db = f.app.db;
  const at = Date.now() - 3 * H;
  db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(f.owner.id, at);
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    f.app,
    { sshUsername: f.owner.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: f.owner },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(dashboardScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain("Since you were here · 3 hours");
  expect(text).toContain("1 landed");
  expect(lastVisit(db, f.owner.id)).toBe(at);
});

test("a prefetch, a preview or a non-document fetch leaves home_visit unchanged; a navigation moves it", async () => {
  const db = f.app.db;
  const at = Date.now() - 3 * H;
  const set = () => db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(f.owner.id, at);
  for (const headers of [
    { "sec-purpose": "prefetch" },
    { purpose: "prefetch" },
    { "sec-purpose": "prefetch;prerender" },
    { "sec-fetch-dest": "empty" },
    { "sec-fetch-dest": "iframe" },
  ]) {
    set();
    const text = await (await fetch(`${f.base}/feed?all=1`, { headers: { cookie: f.ownerCookie, ...headers } })).text();
    expect(text).toContain("Since you were here · 3 hours");
    expect(lastVisit(db, f.owner.id)).toBe(at);
  }
  set();
  await (await fetch(`${f.base}/feed?all=1`, { headers: { cookie: f.ownerCookie, "sec-fetch-dest": "document" } })).text();
  expect(lastVisit(db, f.owner.id)).toBeGreaterThan(at);
});

test("home (not only the feed) leaves the visit mark alone on a prefetch and moves it on a navigation, and names its compartment", async () => {
  const db = f.app.db;
  const at = Date.now() - 3 * H;
  const set = () => db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(f.owner.id, at);
  for (const headers of [{ "sec-purpose": "prefetch" }, { purpose: "prefetch" }, { "sec-fetch-dest": "empty" }]) {
    set();
    const text = await (await fetch(`${f.base}/feed`, { headers: { cookie: f.ownerCookie, ...headers } })).text();
    expect(text).toContain("Since you were here · 3 hours");
    expect(lastVisit(db, f.owner.id)).toBe(at);
  }
  set();
  const text = await (await fetch(`${f.base}/feed`, { headers: { cookie: f.ownerCookie, "sec-fetch-dest": "document" } })).text();
  expect(lastVisit(db, f.owner.id)).toBeGreaterThan(at);
  expect(text).toContain("Since you were here");
});

test("home leaves out the Since compartment when nothing moved", async () => {
  const db = f.app.db;
  db.query("INSERT INTO home_visit (user_id, at) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET at = excluded.at").run(f.peer.id, Date.now());
  db.query("DELETE FROM pull").run();
  const text = await (await fetch(`${f.base}/feed`, { headers: { cookie: f.peerCookie, "sec-fetch-dest": "empty" } })).text();
  expect(text).not.toContain("Since you were here");
});

test("the digest query reads pull through the existing pull_merged index, and the home-visit migration adds no second one", () => {
  const plan = f.app.db
    .query<{ detail: string }, [string, string]>(
      `EXPLAIN QUERY PLAN SELECT p.merged_at FROM pull p WHERE p.merged_at >= ?1 AND p.merged_at <= ?2 ORDER BY p.merged_at DESC LIMIT 200`,
    )
    .all("2026-10-26T00:00:00.000Z", "2026-10-27T00:00:00.000Z")
    .map((r) => r.detail)
    .join("\n");
  expect(plan).toContain("pull_merged");
  const onMerged = f.app.db
    .query<{ name: string }, []>(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'pull' AND sql LIKE '%merged_at%'`)
    .all();
  expect(onMerged.map((r) => r.name)).toEqual(["pull_merged"]);
});
