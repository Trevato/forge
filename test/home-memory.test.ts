/**
 * What home remembers (#7660) is safe to show: it ends when the viewer's access
 * does, its keys are bounded however many queries a client sends, and the
 * stale marker is escaped and has a path without a script.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { forgetAll, forgetRegion, recall, remember } from "../src/core/region_memory.ts";
import { homeRegion, homeVariant } from "../src/web/studio/home_last.ts";
import { raw } from "../src/web/html.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (path: string, cookie: string): Promise<string> => (await fetch(`${f.base}${path}`, { headers: { cookie } })).text();

test("a viewer whose access was revoked is never shown what they remembered", async () => {
  forgetAll(f.app.db);
  await get("/", f.peerCookie);
  const before = await get("/", f.peerCookie);
  expect(before).toContain("olive/app-0");
  // The public repositories turn private: a write, so the next look is stale, but not for pablo.
  f.app.db.query("UPDATE repo SET visibility = 'private' WHERE visibility = 'public'").run();
  const after = await get("/", f.peerCookie);
  expect(after).not.toContain("olive/app-0");
  expect(after).not.toContain("olive/app-3");
  expect(after).not.toContain("data-region data-refresh=");
});

test("an admin who loses admin is not shown the figures they remembered", async () => {
  forgetAll(f.app.db);
  expect(await get("/", f.ownerCookie)).toContain('id="home-kpis"');
  f.app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(f.owner.id);
  expect(await get("/", f.ownerCookie)).not.toContain('id="home-kpis"');
  f.app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(f.owner.id);
});

test("a stale region is marked with an escaped address and a link for a page with no script", async () => {
  forgetAll(f.app.db);
  const path = "/?all=1&a=%22%3E%3Cscript%3E&day=%22onfocus%3D";
  await get(path, f.ownerCookie);
  f.app.db.query("UPDATE repo SET description = 'moved' WHERE id = ?1").run(f.repos[0]!.id);
  const text = await get(path, f.ownerCookie);
  const marked = [...text.matchAll(/data-refresh="([^"]*)"/g)].map((m) => m[1]!);
  expect(marked.length).toBeGreaterThan(0);
  for (const src of marked) expect(src).toMatch(/^\/live\/home\/(kpis|waiting|panels|asked|feed)(\?all=1)?$/);
  expect(text).toContain('<noscript><p class="small muted">Shown as of a moment ago. <a href="/live/home/');
  // The address the script and the link follow answers one region, in one element.
  const res = await fetch(`${f.base}${marked[0]!}`, { headers: { cookie: f.ownerCookie } });
  expect(res.status).toBe(200);
  expect((await res.text()).trim()).toMatch(/^<div[\s>][\s\S]*<\/div>$/);
});

test("the keys a client can make are the few home reads", () => {
  const v = (q: string): string => homeVariant(new URL(`http://x/${q}`));
  expect(v("")).toBe("");
  expect(v("?a=1&b=2&utm=x")).toBe("");
  expect(v("?all=anything")).toBe("?all=1");
  expect(v("?cursor=nonsense&day=2026-01-01")).toBe("");
  expect(v(`?day=%22%3E`)).toBe("");
  expect(v(`?cursor=${"9".repeat(200)}`)).toBe("");
});

test("one viewer's many variants push out only their own", () => {
  const db = f.app.db;
  forgetAll(db);
  remember(db, "bea", "feed", "", "<p>bea</p>", "1.1", "m");
  for (let i = 0; i < 100; i++) remember(db, "mal", "feed", `?n=${i}`, "x", "1.1", "m");
  expect(recall(db, "bea", "feed", "", "m")?.html).toBe("<p>bea</p>");
  let kept = 0;
  for (let i = 0; i < 100; i++) if (recall(db, "mal", "feed", `?n=${i}`, "m") !== undefined) kept++;
  expect(kept).toBe(16);
});

test("a copy is recalled only for the access it was drawn under, and forgetting names what goes", () => {
  const db = f.app.db;
  forgetAll(db);
  remember(db, "bea", "feed", "", "a", "1.1", "m.1");
  remember(db, "bea", "panels", "", "b", "1.1", "m.1");
  expect(recall(db, "bea", "feed", "", "m.2")).toBeUndefined();
  forgetRegion(db, "bea", "panels");
  expect(recall(db, "bea", "panels", "", "m.1")).toBeUndefined();
  expect(recall(db, "bea", "feed", "", "m.1")?.html).toBe("a");
  forgetRegion(db, "bea");
  expect(recall(db, "bea", "feed", "", "m.1")).toBeUndefined();
});

test("a write between deciding a redraw and its timer firing leaves the redrawn copy stale", async () => {
  const db = f.app.db;
  forgetAll(db);
  const request = new Request("http://x/");
  const draw = () => raw("<p>drawn</p>");
  const look = () => homeRegion(db, request, "race-viewer", "feed", "?race", "m", draw);
  await look(); // first look: drawn and remembered current
  db.query("UPDATE repo SET description = 'first' WHERE id = ?1").run(f.repos[0]!.id);
  expect((await look()).text).toContain("data-refresh="); // stale: a redraw is decided, its timer pending
  db.query("UPDATE repo SET description = 'second' WHERE id = ?1").run(f.repos[0]!.id); // lands before the timer fires
  await Bun.sleep(50);
  expect((await look()).text).toContain("data-refresh=");
});
