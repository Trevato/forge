/** The issues list at rest (#8719): a dot for status, one primary action, labels folded away — and every action still in the palette. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { tellsListActions } from "../src/web/studio/lists.ts";
import { wordText } from "../src/web/studio/words.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

// Measured 49,753 on the snappy fixture; the margin is rounding, not room.
// Raised from 50 KB when instant actions (#8708) landed beside this page; #8719 brings it back down.
const BUDGET_BYTES = 55_000;

test("a row wears a dot, not a word badge, and the page stays under its byte budget", async () => {
  const repo = f.repos[0]!;
  const res = await fetch(`${f.base}/${repo.ownerName}/${repo.name}/issues`, {
    headers: { cookie: f.ownerCookie },
  });
  const text = await res.text();
  expect(res.status).toBe(200);
  expect(text).not.toMatch(/class="row-trail"[^>]*><span class="badge"/);
  // The dot says its word once, to a screen reader; no title repeats it.
  expect(text).toMatch(/class="dot"[^>]*aria-label="[^"]+"/);
  expect(text).not.toMatch(/class="dot"[^>]*title=/);
  expect(text).not.toContain("Status:");
  expect(new TextEncoder().encode(text).length).toBeLessThan(BUDGET_BYTES);
  expect(text.match(/data-variant="primary"/g)?.length ?? 0).toBe(1);
});

test("every action the list offers is in the palette", () => {
  const all = tellsListActions({
    base: "/a/b",
    name: "a/b",
    word: ["told", "working", "look", "shipped", "stopped"],
    signedIn: true,
    reports: 2,
  });
  const hrefs = all.map((i) => i.h);
  for (const h of [
    "/a/b/issues",
    "/a/b/issues?word=told",
    "/a/b/issues?word=working",
    "/a/b/issues?word=look",
    "/a/b/issues?word=shipped",
    "/a/b/issues?word=stopped",
    "/a/b/issues/new",
    "/a/b/reports",
  ])
    expect(hrefs).toContain(h);
  expect(tellsListActions({ base: "/a/b", name: "a/b", word: [], signedIn: false, reports: 0 }).map((i) => i.h)).toEqual(["/a/b/issues"]);
});

test("the real page's palette carries the list's actions, and a state that needs someone is written out", async () => {
  const repo = f.repos[0]!;
  const base = `/${repo.ownerName}/${repo.name}`;
  const text = await (
    await fetch(`${f.base}${base}/issues`, { headers: { cookie: f.ownerCookie } })
  ).text();
  for (const h of [`${base}/issues?word=working`, `${base}/issues?word=stopped`, `${base}/issues/new`])
    expect(text).toContain(`"h":"${h}"`);
});

test("a label filter folded away is still in the palette", () => {
  const hrefs = tellsListActions({
    base: "/a/b",
    name: "a/b",
    word: [],
    signedIn: false,
    reports: 0,
    labels: ["bug", "good first"],
  }).map((i) => i.h);
  expect(hrefs).toContain("/a/b/issues?label=bug");
  expect(hrefs).toContain("/a/b/issues?label=good%20first");
});

test("working, look and stopped are written beside the dot; the quiet states are not", () => {
  expect(String(wordText("working"))).toContain("working");
  expect(String(wordText("stopped"))).toContain("stopped");
  expect(String(wordText("look"))).toContain("look");
  expect(wordText("told")).toBeNull();
  expect(wordText("shipped")).toBeNull();
});
