/** /search at phone width and the ⌘K palette are one component: one dialog, one index, one ranking (#10656). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { rankPalette, type PaletteRow } from "../src/web/palette.ts";
import { shellJs } from "../src/web/client.ts";

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

const get = async (path: string) =>
  (await fetch(`${f.base}${path}`, { headers: { cookie: f.ownerCookie } })).text();

function rowsOf(page: string): PaletteRow[] {
  const m = /<script type="application\/json" id="palette-index">([\s\S]*?)<\/script>/.exec(page);
  if (m === null) throw new Error("no palette index");
  const data = JSON.parse(m[1]!) as { items: { t: string; h: string; c: string }[] };
  return data.items.map((i) => ({ t: i.t, h: i.h, g: i.c }));
}

test("both entry points carry the same dialog and index, and rank to the same top row", async () => {
  const search = await get("/search");
  const other = await get("/");
  for (const p of [search, other]) expect(p).toContain('id="palette"');
  expect(search).toContain("data-palette-auto");
  expect(other).not.toContain("data-palette-auto");
  const a = rowsOf(search);
  const b = rowsOf(other);
  expect(a.length).toBeGreaterThan(0);
  for (const q of ["search", "set", "new"]) {
    const top = (rows: PaletteRow[]) => rankPalette(rows, q, [], 20)[0]?.rows[0]?.h;
    expect(top(a)).toBe(top(b));
  }
});

import { opensAsSheet } from "../src/web/palette.ts";

test("the sheet opens by itself only when the page asks and the width is a phone's", () => {
  expect(opensAsSheet(true, 360)).toBe(true);
  expect(opensAsSheet(true, 390)).toBe(true);
  expect(opensAsSheet(true, 719)).toBe(true);
  expect(opensAsSheet(true, 720)).toBe(false);
  expect(opensAsSheet(true, 1280)).toBe(false);
  expect(opensAsSheet(false, 390)).toBe(false);
});

/** Run the real shell against a stub DOM; report what the palette dialog did. */
function runShell(opts: { marked: boolean; width: number }) {
  const log = { shown: 0, focused: 0, closed: 0 };
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const make = (id = ""): any => {
    const state: { open?: boolean } = {};
    const el: any = new Proxy(function () {}, {
      get(_t, k) {
        if (k === "id") return id;
        if (k === "open") return state.open === true;
        if (k === "showModal") return () => { state.open = true; if (id === "palette") log.shown++; };
        if (k === "close") return () => { state.open = false; if (id === "palette") log.closed++; };
        if (k === "focus") return () => { if (id === "palette-input") log.focused++; };
        if (k === "value") return "";
        if (k === "length") return 0;
        if (k === "classList") return { add() {}, remove() {}, contains: () => false };
        if (k === "style" || k === "dataset") return {};
        if (k === "addEventListener") return (n: string, f: (e: unknown) => void) => ((listeners[n] ??= []).push(f));
        if (k === "querySelectorAll") return () => [];
        if (k === "querySelector") return (sel: string) => (sel.includes("palette-input") ? make("palette-input") : sel.includes("palette-list") ? make("palette-list") : make());
        if (k === Symbol.toPrimitive) return () => "";
        return typeof k === "string" && /^(get|set|has|remove|append|insert|contains|matches|closest|click)/i.test(k) ? () => (k.startsWith("has") || k === "matches" ? false : null) : undefined;
      },
      set() { return true; },
      apply() { return null; },
    });
    return el;
  };
  const palette = make("palette");
  const doc: any = new Proxy({}, {
    get(_t, k) {
      if (k === "getElementById") return (id: string) => (id === "palette" ? palette : id === "palette-index" ? { textContent: "{}" } : null);
      if (k === "querySelector") return (sel: string) => (sel.includes("data-palette-auto") ? (opts.marked ? make() : null) : null);
      if (k === "querySelectorAll") return () => [];
      if (k === "addEventListener") return (n: string, f: (e: unknown) => void) => ((listeners[n] ??= []).push(f));
      if (k === "documentElement") return make();
      if (k === "activeElement") return null;
      if (k === "contains") return () => false;
      if (k === "createElement") return () => make();
      if (k === "body" || k === "head") return make();
      if (k === "readyState") return "complete";
      return typeof k === "string" && /^create/.test(k) ? () => make() : undefined;
    },
  });
  const win: any = { innerWidth: opts.width, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { pathname: "/search", search: "", href: "" }, localStorage: undefined };
  try {
    new Function("document", "window", "location", "localStorage", "fetch", "performance", `${shellJs}`)(doc, win, win.location, undefined, () => new Promise(() => {}), { now: () => 0 });
  } catch (e) {
    throw new Error(`shell did not run under the stub: ${String(e)}`);
  }
  return { log, palette };
}

test("run for real: the marked page opens the sheet at 390px, not at 1280px, not unmarked", () => {
  expect(runShell({ marked: true, width: 390 }).log.shown).toBe(1);
  expect(runShell({ marked: true, width: 360 }).log.shown).toBe(1);
  expect(runShell({ marked: true, width: 1280 }).log.shown).toBe(0);
  expect(runShell({ marked: false, width: 390 }).log.shown).toBe(0);
});

test("focus lands in the palette input; Escape closes it and focus returns to what had it", () => {
  const r = runShell({ marked: true, width: 390 });
  expect(r.log.focused).toBeGreaterThan(0);
  // openModal remembers document.activeElement (the page's autofocused search
  // input) and refocuses it on close, Escape included (client.ts modalJs).
  expect(shellJs).toMatch(/var was = document\.activeElement;[\s\S]*?was\.focus\(\)/);
  expect(shellJs).toMatch(/if \(e\.key !== 'Escape'\) return;[\s\S]*?close\(\);/);
});
