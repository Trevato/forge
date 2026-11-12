/**
 * New things arrive in place (#11625): an event on a list page merges the
 * page's fresh rows into the list — no refresh bar. At the top rows slide in;
 * scrolled or typing, they land above with the scroll compensated and a quiet
 * "N above" marker; a dropped stream says so and catches up on return.
 */
import { expect, test } from "bun:test";
import { liveClientJs, liveMount } from "../src/web/live.ts";

const li = (n: number, extra = "") =>
  `<li><a href="/a/b/issues/${n}" class="row"><span class="row-title">Issue ${n}${extra}</span></a></li>`;
const list = (ns: number[], extra = "") => `<ul class="list">${ns.map((n) => li(n, extra)).join("")}</ul>`;

async function boot(initial: number[]) {
  const { Window } = await import("happy-dom");
  const win = new Window({ url: "http://forge.test/a/b/issues" });
  win.document.body.innerHTML = `<main>${list(initial)}<input id="q"></main>${String(liveMount({ repo: "/a/b" }))}`;
  const listeners = new Map<string, (e: { data: string }) => void>();
  const sources: FakeSource[] = [];
  class FakeSource {
    handlers = new Map<string, () => void>();
    constructor() { sources.push(this); }
    addEventListener(kind: string, f: (e: { data: string }) => void) {
      listeners.set(kind, f);
      this.handlers.set(kind, f as () => void);
    }
    close() {}
  }
  let page = list(initial);
  let fetches = 0;
  const fakeFetch = async () => {
    fetches++;
    return { ok: true, status: 200, text: async () => `<main>${page}</main>` };
  };
  const state = { scrollY: 0, scrolled: [] as number[] };
  Object.defineProperty(win, "pageYOffset", { get: () => state.scrollY });
  (win as unknown as { scrollBy: (x: number, y: number) => void }).scrollBy = (_x, y) => state.scrolled.push(y);
  (win as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo = (_x, y) => { state.scrollY = y; };
  new Function("document", "window", "location", "EventSource", "fetch", liveClientJs)(
    win.document, win, win.location, FakeSource, fakeFetch,
  );
  // Rows are 100px tall, stacked in document order, so inserting N above a row moves it N*100px down.
  win.HTMLElement.prototype.getBoundingClientRect = function (this: { tagName: string; parentElement: { children: ArrayLike<unknown> } | null }) {
    const at = this.parentElement ? Array.from(this.parentElement.children).indexOf(this) : 0;
    const top = this.tagName === "LI" ? at * 100 : 0;
    return { top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top } as never;
  } as never;
  const send = (kind = "issue.opened") =>
    listeners.get(kind)?.({ data: JSON.stringify({ kind, payload: { number: 9 } }) });
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const doc = win.document;
  const titles = () => [...doc.querySelectorAll("ul.list li")].map((e) => e.textContent!.trim());
  return { win, doc, send, wait, titles, sources, state, fetches: () => fetches, setPage: (p: string) => { page = p; } };
}

test("a new row appears at the top within a second with no click, and no bar is drawn", async () => {
  const t = await boot([2, 1]);
  t.setPage(list([3, 2, 1]));
  t.send();
  await t.wait(700);
  expect(t.titles()).toEqual(["Issue 3", "Issue 2", "Issue 1"]);
  expect(t.doc.querySelector("ul.list li")!.classList.contains("live-arrived")).toBe(true);
  expect(t.doc.getElementById("live-above")!.hasAttribute("hidden")).toBe(true);
  expect(t.doc.body.textContent).not.toMatch(/refresh/i);
});

test("a burst of events is one fetch", async () => {
  const t = await boot([1]);
  t.setPage(list([4, 3, 2, 1]));
  for (let i = 0; i < 20; i++) t.send();
  await t.wait(700);
  expect(t.fetches()).toBe(1);
  expect(t.titles()).toEqual(["Issue 4", "Issue 3", "Issue 2", "Issue 1"]);
});

test("a reader scrolled down keeps their place: rows land above, marker counts them, click jumps up", async () => {
  const t = await boot([2, 1]);
  t.state.scrollY = 500;
  t.setPage(list([4, 3, 2, 1]));
  t.send();
  await t.wait(700);
  expect(t.titles()).toEqual(["Issue 4", "Issue 3", "Issue 2", "Issue 1"]);
  expect(t.doc.querySelector("ul.list li")!.classList.contains("live-arrived")).toBe(false);
  const marker = t.doc.getElementById("live-above")!;
  expect(marker.hasAttribute("hidden")).toBe(false);
  expect(marker.textContent).toBe("2 above");
  marker.dispatchEvent(new t.win.Event("click", { cancelable: true }));
  expect(t.state.scrollY).toBe(0);
  expect(marker.hasAttribute("hidden")).toBe(true);
});

test("a reader typing is treated like a scrolled one; the row they are in is not replaced", async () => {
  const t = await boot([2, 1]);
  (t.doc.getElementById("q") as unknown as { focus(): void }).focus();
  t.setPage(list([3, 2, 1], " (edited)"));
  t.send();
  await t.wait(700);
  expect(t.doc.getElementById("live-above")!.textContent).toBe("1 above");
  // a changed row updates in place, order stable
  expect(t.titles()).toEqual(["Issue 3 (edited)", "Issue 2 (edited)", "Issue 1 (edited)"]);
});

test("a focused row is held while others update", async () => {
  const t = await boot([2, 1]);
  (t.doc.querySelectorAll("ul.list a")[1] as unknown as { focus(): void }).focus();
  t.setPage(list([2, 1], " (edited)"));
  t.send();
  await t.wait(700);
  expect(t.titles()).toEqual(["Issue 2 (edited)", "Issue 1"]);
});

test("a dropped connection says so in a word and catches up when it returns, no reload", async () => {
  const t = await boot([1]);
  const conn = t.doc.getElementById("live-conn")!;
  const es = t.sources[0]!;
  es.handlers.get("error")!();
  expect(conn.hasAttribute("hidden")).toBe(true); // not at once: a navigation errors the stream too
  await t.wait(2100);
  expect(conn.hasAttribute("hidden")).toBe(false);
  expect(conn.textContent).toBe("offline");
  t.setPage(list([2, 1]));
  es.handlers.get("open")!();
  expect(conn.hasAttribute("hidden")).toBe(true);
  await t.wait(700);
  expect(t.titles()).toEqual(["Issue 2", "Issue 1"]);
});

test("a stream that errors and returns within two seconds never shows offline", async () => {
  const t = await boot([1]);
  const es = t.sources[0]!;
  es.handlers.get("error")!();
  await t.wait(300);
  es.handlers.get("open")!();
  await t.wait(2000);
  expect(t.doc.getElementById("live-conn")!.hasAttribute("hidden")).toBe(true);
});

test("scrolled down, new rows above shift the reader's row and the scroll is compensated by exactly that", async () => {
  const t = await boot([2, 1]);
  t.state.scrollY = 500;
  t.setPage(list([4, 3, 2, 1]));
  t.send();
  await t.wait(700);
  expect(t.state.scrolled).toEqual([200]);
});

test("the same holds when the reader's own row is replaced by a changed one", async () => {
  const t = await boot([2, 1]);
  t.state.scrollY = 500;
  t.setPage(list([4, 3, 2, 1], " (edited)"));
  t.send();
  await t.wait(700);
  expect(t.titles()[2]).toBe("Issue 2 (edited)");
  expect(t.state.scrolled).toEqual([200]);
});

test("activating the marker moves focus to the first row", async () => {
  const t = await boot([2, 1]);
  t.state.scrollY = 500;
  t.setPage(list([3, 2, 1]));
  t.send();
  await t.wait(700);
  t.doc.getElementById("live-above")!.dispatchEvent(new t.win.Event("click", { cancelable: true }));
  expect(t.doc.activeElement).toBe(t.doc.querySelector("ul.list li a") as unknown as never);
});

test("arrived rows lose their class on a timer, so reduced motion never strands it, and the CSS turns the animation off", async () => {
  const t = await boot([1]);
  t.setPage(list([2, 1]));
  t.send();
  await t.wait(700);
  expect(t.doc.querySelector("ul.list li")!.classList.contains("live-arrived")).toBe(true);
  await t.wait(500);
  expect(t.doc.querySelector("ul.list li")!.classList.contains("live-arrived")).toBe(false);
  const css = await Bun.file(new URL("../src/web/style/components.ts", import.meta.url)).text();
  expect(css).toMatch(/prefers-reduced-motion: reduce\) \{[^}]*animation-duration: \.01ms !important/);
});
