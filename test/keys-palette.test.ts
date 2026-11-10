/** `:` opens a one-line go-to-page prompt built from one list of pages (#10434). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { GO_MATCH_JS, GO_PAGES, goLevel, goPagesData, goPagesFor, goPaletteRows } from "../src/web/go_pages.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

type Row = [string, string, number];
// The very source the browser receives, run here as a function.
const goMatch = new Function(`${GO_MATCH_JS}; return goMatch;`)() as (pages: Row[], q: string) => Row[];
const all = goPagesData();
const hit = (q: string) => goMatch(all, q).map((p) => p[0]);
const names = (v: { signedIn: boolean; admin: boolean }) => goPagesFor(v).map((p) => p.name);

test("the page list is plain data, scoped by who is looking", () => {
  expect(names({ signedIn: false, admin: false })).toEqual(["Home", "Apps", "Explore", "Packs", "Front page", "Search"]);
  const user = names({ signedIn: true, admin: false });
  for (const n of ["Board", "Flow", "Feed"]) expect(user).toContain(n);
  expect(user).not.toContain("System");
  const admin = names({ signedIn: true, admin: true });
  for (const n of ["System", "Releases"]) expect(admin).toContain(n);
  expect(new Set(GO_PAGES.map((p) => p.href)).size).toBe(GO_PAGES.length);
  expect(goLevel({ signedIn: false, admin: false })).toBe(0);
  expect(goLevel({ signedIn: true, admin: true })).toBe(2);
});

test("the filter: substring match, case and space ignored, a prefix beats a substring", () => {
  expect(hit("flow")).toEqual(["Flow"]);
  expect(hit("  FLOW ")).toEqual(["Flow"]);
  expect(hit("")).toEqual(all.map((p) => p[0]));
  // "bo" starts Board and Boards; "Notes"/"Talk" etc. do not contain it.
  expect(hit("bo").slice(0, 2)).toEqual(["Board", "Boards"]);
  // "s" starts Search, Settings, System; "Apps" and "Asks" only contain it, so they follow.
  const s = hit("s");
  expect(s.indexOf("System")).toBeLessThan(s.indexOf("Apps"));
  expect(goMatch(all, "s")[0]![0]).toBe("Search");
  // a contained, not leading, match still counts
  expect(hit("rds")).toEqual(["Boards"]);
});

test("no match is an empty list, so Enter has nothing to open", () => {
  expect(hit("zzzz")).toEqual([]);
});

test("the Cmd/Ctrl K palette's Go to rows come from the same list", () => {
  const rows = goPaletteRows();
  for (const r of rows) expect(GO_PAGES.some((p) => p.href === r.h)).toBe(true);
  expect(rows.filter((r) => r.visitor).map((r) => r.t)).toContain("Forge packs");
});

test("every listed page answers: no href is a dead route", async () => {
  for (const p of GO_PAGES) {
    const r = await fetch(`${f.base}${p.href}`, { headers: { cookie: f.ownerCookie }, redirect: "manual" });
    expect(r.status, p.href).not.toBe(404);
    expect(r.status, p.href).toBeLessThan(500);
  }
});

test("a page wears only the viewer's level; no prompt markup is drawn until : is pressed", async () => {
  const owner = await (await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } })).text();
  expect(owner).toMatch(/<body[^>]*data-go="[12]"/);
  expect(owner).not.toContain('id="goto"');
  const anon = await (await fetch(`${f.base}/`)).text();
  expect(anon).toMatch(/<body[^>]*data-go="0"/);
  expect(anon).not.toContain('href="/board"');
});

test("the keys script: : opens the combobox prompt, announces the lead, says when nothing matches", async () => {
  const page = await (await fetch(`${f.base}/`)).text();
  const path = /src="([^"]*\.js[^"]*)"/.exec(page.slice(page.indexOf("<body")))![1]!;
  const js = await (await fetch(`${f.base}${path}`)).text();
  expect(js).toContain("e.key === ':'");
  expect(js).toMatch(/e\.key === ':'\) \{ seq\.length = 0; e\.preventDefault\(\); openGoto\(\)/);
  expect(js).toContain("function goMatch(pages, q)");
  for (const a of ["'combobox'", "'aria-controls', 'goto-list'", "aria-activedescendant", "'listbox'", "'option'"]) expect(js).toContain(a);
  expect(js).not.toContain("data-goto");
  expect(js).toContain("No page called that");
  expect(js).toContain('"Flow","/flow",1');
  // The field guard returns before the key chain, so a colon typed in a box is a colon.
  const src = readFileSync(new URL("../src/web/client.ts", import.meta.url), "utf8");
  expect(src.indexOf("t.matches('input, textarea, select, [contenteditable]')")).toBeLessThan(src.indexOf("openGoto();"));
});
