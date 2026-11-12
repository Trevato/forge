import { expect, test } from "bun:test";
import { shellJs } from "../src/web/client.ts";
import { GO_PAGES, goPagesFor } from "../src/web/go_pages.ts";

const keyed = GO_PAGES.filter((p) => p.key !== undefined);

test("every g-letter is one lowercase letter, bound once", () => {
  const letters = keyed.map((p) => p.key as string);
  for (const l of letters) expect(l).toMatch(/^[a-z]$/);
  expect(new Set(letters).size).toBe(letters.length);
});

test("the main pages are bound: g h, g f, g e, g s", () => {
  const at = (k: string) => keyed.find((p) => p.key === k)?.href;
  expect(at("h")).toBe("/");
  expect(at("f")).toBe("/flow");
  expect(at("e")).toBe("/explore");
  expect(at("s")).toBe("/system");
});

test("a page has one binding; every target is a page of the list", () => {
  expect(new Set(keyed.map((p) => p.href)).size).toBe(keyed.length);
  expect(keyed.length).toBeGreaterThanOrEqual(4);
});

test("a viewer is offered only the targets they can open", () => {
  const keys = (v: { signedIn: boolean; admin: boolean }) => goPagesFor(v).filter((p) => p.key).map((p) => p.key);
  expect(keys({ signedIn: false, admin: false })).toEqual(["h", "e"]);
  expect(keys({ signedIn: true, admin: false })).not.toContain("s");
  expect(keys({ signedIn: true, admin: true })).toContain("s");
});

// The real keys script, run against a minimal fake document: it records the listeners
// and the pages it was sent to, and finds nothing on the page.
function keys(level: number) {
  const handlers: Array<(e: any) => void> = [];
  const assigned: string[] = [];
  const el: any = new Proxy(function () {}, { get: (_t, k) => (k === "length" ? 0 : el), apply: () => el });
  const doc: any = {
    body: { getAttribute: (n: string) => (n === "data-go" ? String(level) : null) },
    documentElement: { classList: { add() {} }, setAttribute() {}, removeAttribute() {}, hasAttribute: () => false },
    activeElement: null,
    currentScript: null,
    addEventListener: (t: string, f: any) => t === "keydown" && handlers.push(f),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => el,
  };
  const win: any = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  const loc: any = { pathname: "/", search: "", assign: (h: string) => assigned.push(h) };
  new Function("document", "window", "location", "sessionStorage", "CSS", shellJs)(doc, win, loc, undefined, undefined);
  const press = (key: string, extra: any = {}) => {
    const e = { key, target: null, metaKey: false, ctrlKey: false, altKey: false, defaultPrevented: false, preventDefault() {}, ...extra };
    for (const h of handlers) h(e);
  };
  return { press, assigned };
}
const realNow = Date.now;
const clock = (t: number) => (Date.now = () => t);

test("the script: a stranger's g f does nothing, a user's goes to /flow, g h and g e work for all", () => {
  const stranger = keys(0);
  clock(10_000);
  stranger.press("g");
  stranger.press("f");
  expect(stranger.assigned).toEqual([]);
  stranger.press("g");
  stranger.press("e");
  expect(stranger.assigned).toEqual(["/explore"]);
  const user = keys(1);
  user.press("g");
  user.press("f");
  expect(user.assigned).toEqual(["/flow"]);
  user.press("g");
  user.press("s");
  expect(user.assigned).toEqual(["/flow"]);
  const admin = keys(2);
  admin.press("g");
  admin.press("s");
  expect(admin.assigned).toEqual(["/system"]);
  Date.now = realNow;
});

test("the script: a pause over 1 s forgets the g", () => {
  const u = keys(1);
  clock(10_000);
  u.press("g");
  clock(11_500);
  u.press("f");
  expect(u.assigned).toEqual([]);
  clock(20_000);
  u.press("g");
  clock(20_900);
  u.press("f");
  expect(u.assigned).toEqual(["/flow"]);
  Date.now = realNow;
});

test("the script: ctrl or meta with g, and g typed in a field, jump nowhere", () => {
  const u = keys(1);
  clock(10_000);
  u.press("g", { ctrlKey: true });
  u.press("f");
  u.press("g", { metaKey: true });
  u.press("f");
  const input = { matches: (s: string) => s.includes("input"), closest: () => null };
  u.press("g", { target: input });
  u.press("f", { target: input });
  expect(u.assigned).toEqual([]);
  Date.now = realNow;
});
