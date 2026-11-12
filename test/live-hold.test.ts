/**
 * A live region marked data-live-hold is not swapped while the reader is
 * scrolled into it (#6693): the client says `forge:held` with the fresh markup.
 */

import { describe, expect, test } from "bun:test";
import { liveRegionsJs } from "../src/web/client.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function run(hold: boolean, top: number, bottom = 400) {
  const view = { top };
  const events: { type: string; detail?: Any }[] = [];
  const region: Any = {
    id: "r",
    innerHTML: "<p>old</p>",
    attributes: [],
    getAttribute: (n: string) => (n === "data-live" ? "run.*" : null),
    hasAttribute: (n: string) => hold && n === "data-live-hold",
    removeAttribute() {},
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    contains: () => false,
    getBoundingClientRect: () => ({ top: view.top, bottom }),
    dispatchEvent: (e: Any) => events.push(e),
  };
  const fresh: Any = { ...region, innerHTML: "<p>new</p>", attributes: [] };
  const handlers: Record<string, (e: Any) => void> = {};
  class ES {
    addEventListener(t: string, f: (e: Any) => void) { handlers[t] = f; }
    close() {}
  }
  const doc: Any = {
    hidden: false,
    activeElement: null,
    querySelectorAll: (sel: string) => (sel === "[data-live]" ? [region] : []),
    getElementById: () => region,
    querySelector: () => null,
    createElement: () => ({
      set innerHTML(_v: string) {},
      content: { getElementById: () => fresh, querySelector: () => null },
    }),
    addEventListener() {},
    dispatchEvent() {},
  };
  const win: Any = { addEventListener() {}, setInterval: () => 1, clearInterval() {} };
  // The server's answer never changes: it honours If-None-Match as a real one does.
  const fetchFn = async (_u: string, init: Any) =>
    init.headers["if-none-match"] === '"v1"'
      ? { status: 304, ok: false, headers: { get: () => null }, text: async () => "" }
      : { status: 200, ok: true, headers: { get: () => '"v1"' }, text: async () => "x" };
  class DP { parseFromString() { return { getElementById: () => fresh, querySelector: () => null }; } }
  class CE { constructor(public type: string, init: Any = {}) { Object.assign(this, init); } }
  new Function("document", "window", "EventSource", "CustomEvent", "fetch", "location", "setTimeout", "Date", "DOMParser", liveRegionsJs)(
    doc, win, ES, CE, fetchFn, { href: "http://x/" }, (f: () => void) => { queueMicrotask(f); return 1; }, Date, DP,
  );
  const poke = async () => {
    handlers.forge!({ lastEventId: "1", data: JSON.stringify({ kind: "run.done", repo: "a" }) });
    await new Promise((r) => setTimeout(r, 20));
  };
  await poke();
  return { region, events, view, poke };
}

describe("data-live-hold", () => {
  test("scrolled into the region: not swapped, forge:held carries the fresh markup", async () => {
    const { region, events } = await run(true, -40);
    expect(region.innerHTML).toBe("<p>old</p>");
    const held = events.find((e) => e.type === "forge:held") as Any;
    expect(held.bubbles).toBe(true);
    expect(held.detail.html).toBe("<p>new</p>");
    expect(events.some((e) => e.type === "forge:swapped")).toBe(false);
  });
  test("at the top: swapped as ever", async () => {
    const { region, events } = await run(true, 0);
    expect(region.innerHTML).toBe("<p>new</p>");
    expect(events.map((e) => e.type)).toEqual(["forge:swapped"]);
  });
  test("without the attribute: swapped even when scrolled", async () => {
    const { region, events } = await run(false, -40);
    expect(region.innerHTML).toBe("<p>new</p>");
    expect(events.map((e) => e.type)).toEqual(["forge:swapped"]);
  });
  test("entirely above the viewport: not read, so swapped", async () => {
    const { region } = await run(true, -500, -100);
    expect(region.innerHTML).toBe("<p>new</p>");
  });
  test("held, then the reader returns to the top: the next pull swaps without a server change", async () => {
    const { region, events, view, poke } = await run(true, -40);
    expect(region.innerHTML).toBe("<p>old</p>");
    view.top = 0;
    await poke();
    expect(region.innerHTML).toBe("<p>new</p>");
    expect(events.map((e) => e.type)).toEqual(["forge:held", "forge:swapped"]);
  });
});
