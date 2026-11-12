/** The lists that ask for a decision answer j/k, enter, esc and `?` (#10710): driven through a real DOM. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { shellJs } from "../src/web/client.ts";

type Win = InstanceType<Awaited<typeof import("happy-dom")>["Window"]>;

const LIST = `<ul><li><a class="row" href="/a/b/issues/1" data-nav tabindex="-1">One</a></li>
  <li><a class="row" href="/a/b/issues/2" data-nav tabindex="-1">Two</a></li></ul>`;

/** A page with the shell script running; `store` is the tab's sessionStorage. */
async function page(path: string, body: string, store: Record<string, string> = {}) {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: `http://forge.test${path}` });
  for (const [k, v] of Object.entries(store)) win.sessionStorage.setItem(k, v);
  win.document.body.innerHTML = body;
  (win.HTMLElement.prototype as any).scrollIntoView ??= () => {};
  const errors: unknown[] = [];
  win.addEventListener('error', (e: any) => errors.push(e.message ?? e.error));
  const assigned: string[] = [];
  const loc = new Proxy(win.location, {
    get: (t, k) => (k === "assign" ? (u: string) => void assigned.push(u) : (t as any)[k]),
  });
  new Function("document", "window", "location", "sessionStorage", "CSS", "fetch", "EventSource", shellJs)(
    win.document, win, loc, win.sessionStorage, { escape: (x: string) => x.replace(/([^\w-])/g, "\\$1") }, async () => ({ ok: false, status: 500, text: async () => "", headers: { get: () => null } }), undefined,
  );
  const key = (k: string, target: unknown = win.document) => {
    const e = new win.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
    (target as any).dispatchEvent(e);
    return e;
  };
  return { win, doc: win.document, key, assigned, errors };
}

const focusedHref = (w: Win) => (w.document.activeElement as any)?.getAttribute?.("href");

test("j moves down the rows, k up, and Enter opens the focused one, remembering the list", async () => {
  const p = await page("/a/b/issues", LIST);
  p.key("j");
  expect(focusedHref(p.win)).toBe("/a/b/issues/1");
  p.key("j");
  expect(focusedHref(p.win)).toBe("/a/b/issues/2");
  p.key("k");
  expect(focusedHref(p.win)).toBe("/a/b/issues/1");
  p.key("j");
  let clicked = "";
  p.doc.addEventListener("click", (e) => { clicked = (e.target as any).getAttribute("href"); e.preventDefault(); }, true);
  p.key("Enter");
  expect(clicked).toBe("/a/b/issues/2");
  expect(JSON.parse(p.win.sessionStorage.getItem("nav-from")!)).toMatchObject({ list: "/a/b/issues", to: "/a/b/issues/2", href: "/a/b/issues/2" });
});

const place = JSON.stringify({ list: "/a/b/issues", to: "/a/b/issues/2", href: "/a/b/issues/2" });

test("Esc on the opened page goes back to its list", async () => {
  const p = await page("/a/b/issues/2", "<main>thread</main>", { "nav-from": place });
  const e = p.key("Escape");
  expect(p.assigned).toEqual(["/a/b/issues"]);
  expect(e.defaultPrevented).toBe(true);
});

test("the list refocuses the row that was opened, once", async () => {
  const p = await page("/a/b/issues", LIST, { "nav-from": place });
  expect(focusedHref(p.win)).toBe("/a/b/issues/2");
  expect(p.win.sessionStorage.getItem("nav-from")).toBeNull();
});

test("Esc elsewhere than the opened page does nothing", async () => {
  const p = await page("/a/b/pulls", "<main>x</main>", { "nav-from": place });
  p.key("Escape");
  expect(p.assigned).toEqual([]);
});

test("Esc with a dialog, an open menu or the hints on closes that first and does not leave", async () => {
  const dlg = await page("/a/b/issues/2", "<main>t</main><dialog open>sheet</dialog>", { "nav-from": place });
  dlg.key("Escape");
  expect(dlg.assigned).toEqual([]);

  const menu = await page("/a/b/issues/2", '<main>t</main><details class="menu" open><summary>m</summary></details>', { "nav-from": place });
  menu.key("Escape");
  expect(menu.doc.querySelector("details.menu")!.hasAttribute("open")).toBe(false);
  expect(menu.assigned).toEqual([]);

  const hints = await page("/a/b/issues/2", "<main>t</main>", { "nav-from": place });
  hints.key("Alt");
  expect(hints.doc.documentElement.hasAttribute("data-hints")).toBe(true);
  hints.key("Escape");
  expect(hints.doc.documentElement.hasAttribute("data-hints")).toBe(false);
  expect(hints.assigned).toEqual([]);
  hints.key("Escape");
  expect(hints.assigned).toEqual(["/a/b/issues"]);
});

test("Esc in a field leaves the field, not the page", async () => {
  const p = await page("/a/b/issues/2", "<main><textarea id=t></textarea></main>", { "nav-from": place });
  const t = p.doc.getElementById("t") as any;
  t.focus();
  p.key("Escape", t);
  expect(p.assigned).toEqual([]);
});

test("a malformed or foreign stored place never throws and never navigates", async () => {
  for (const bad of ["{not json", "42", '{"list":"//evil.test/","to":"/a/b/issues/2"}', '{"list":"https://evil.test","to":"/a/b/issues/2"}']) {
    const p = await page("/a/b/issues/2", "<main>t</main>", { "nav-from": bad });
    p.key("j");
    p.key("Escape");
    expect(p.assigned).toEqual([]);
  }
  const l = await page("/a/b/issues", LIST, { "nav-from": "{oops" });
  l.key("j");
  expect(focusedHref(l.win)).toBe("/a/b/issues/1");
});

test("? opens the one help sheet on the first press", async () => {
  const p = await page("/a/b/issues", `${LIST}<dialog id="help-dialog"><div data-help-body></div></dialog>`);
  let shown = 0;
  (p.doc.getElementById("help-dialog") as any).showModal = () => void shown++;
  p.key("?");
  expect(shown).toBe(1);
  expect(p.doc.documentElement.hasAttribute("data-hints")).toBe(false);
});

let f: SnappyFixture;
beforeAll(async () => { f = await snappyFixture(); }, 120_000);
afterAll(async () => { await f.close(); });

test("the issues list the server draws carries data-nav rows, and the pulls list's rows are declared nav", async () => {
  const repo = f.repos[0]!;
  const get = async (path: string) => (await fetch(`${f.base}${path}`, { headers: { cookie: f.ownerCookie } })).text();
  expect(await get(`/${repo.ownerName}/${repo.name}/issues`)).toMatch(/<[^>]*\bdata-nav\b/);
  // The fixture has no open pull to draw; the row the pulls list builds is the one declared here.
  const lists = readFileSync(new URL("../src/web/studio/lists.ts", import.meta.url), "utf8");
  const pulls = lists.slice(lists.indexOf("export async function changesList"), lists.indexOf("export function isWorkingNow"));
  expect(pulls).toMatch(/row\(\{\s*href: changeHref\(base, pull\.number\),\s*nav: true,/);
});
