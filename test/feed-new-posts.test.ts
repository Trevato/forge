/**
 * Posts that arrive while the reader is inside the feed wait behind one
 * button (#6694): the region holds, the slot is hidden until then, and the
 * listener counts against what is on screen.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";
import { freshHome } from "./helpers/home-fresh.ts";
import { feedJs, feedNote } from "../src/web/studio/feed.ts";
import { heldPostsJs } from "../src/web/studio/held_posts.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

describe("new posts, server side", () => {
  test("the served home carries a held, focusable #live-feed and the polite slot", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-new-posts-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    try {
      const r = await createUser(app.db, { origin: "seed", trusted: true, username: "root", allowReserved: true, email: "root@forge.local", password: "a-good-passphrase", adminIfFirst: true });
      if (!r.ok) throw new Error(r.error);
      const cookie = `forge_session=${createSession(app.db, r.value.id).token}`;
      const page = await freshHome(servers.url, cookie, "/feed");
      expect(page).toMatch(/<section[^>]*id="live-feed"[^>]*data-live-hold/s);
      expect(page).toMatch(/<section[^>]*id="live-feed"[^>]*tabindex="-1"/s);
      expect(page).toMatch(/<p id="new-posts"[^>]*role="status"[^>]*aria-live="polite">\s*<button hidden/);
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
  test("the slot is a polite status with its button hidden", () => {
    const slot = String(feedNote());
    expect(slot).toMatch(/<p id="new-posts"[^>]*role="status"[^>]*aria-live="polite">\s*<button hidden/);
  });
  test("the page's script carries heldPostsJs", () => {
    expect(feedJs).toContain(heldPostsJs);
  });
});

function drive(shown: string[]) {
  const listeners: Record<string, (e: Any) => void> = {};
  const clicks: (() => void)[] = [];
  const events: string[] = [];
  const scrolls: unknown[][] = [];
  const cards = (ids: string[]) => ids.map((id) => ({ getAttribute: () => id }));
  const focused: unknown[] = [];
  const feed: Any = {
    focus: (o: unknown) => focused.push(o),
    innerHTML: shown.join(","),
    addEventListener: (t: string, f: (e: Any) => void) => { listeners[t] = f; },
    querySelectorAll: () => cards(shown),
    dispatchEvent: (e: Any) => events.push(e.type),
  };
  const button: Any = { hidden: true, textContent: "New posts", addEventListener: (_t: string, f: () => void) => clicks.push(f) };
  const slot: Any = { querySelector: () => button };
  const els: Record<string, Any> = { "live-feed": feed, "new-posts": slot };
  const doc: Any = {
    getElementById: (id: string) => els[id] ?? null,
    createElement: () => {
      const t: Any = { content: { querySelectorAll: () => cards(String(t.innerHTML) === "" ? [] : String(t.innerHTML).split(",")) } };
      return t;
    },
    addEventListener() {},
  };
  const win: Any = { addEventListener() {}, scrollTo: (...a: unknown[]) => scrolls.push(a) };
  class CE { constructor(public type: string, init: Any = {}) { Object.assign(this, init); } }
  new Function("document", "window", "fetch", "CustomEvent", "location", "navigator", "setTimeout", feedJs)(
    doc, win, async () => ({ ok: true }), CE, { pathname: "/" }, {}, () => 1,
  );
  return { focused, feed, slot, button, listeners, clicks, events, scrolls };
}

describe("new posts, in the browser", () => {
  test("three new posts make one button; pressing swaps once and scrolls up", () => {
    const d = drive(["a", "b"]);
    expect(d.button.hidden).toBe(true);
    d.listeners["forge:held"]!({ detail: { html: "x,y,z,a,b" } });
    expect(d.button.hidden).toBe(false);
    expect(d.button.textContent).toBe("3 new posts");
    d.clicks[0]!();
    expect(d.feed.innerHTML).toBe("x,y,z,a,b");
    expect(d.events).toEqual(["forge:swapped"]);
    expect(d.scrolls).toEqual([[0, 0]]);
    expect(d.focused).toEqual([{ preventScroll: true }]);
    expect(d.button.hidden).toBe(true);
    d.clicks[0]!();
    expect(d.events).toEqual(["forge:swapped"]);
  });
  test("a later hold replaces the held markup", () => {
    const d = drive(["a"]);
    d.listeners["forge:held"]!({ detail: { html: "x,a" } });
    expect(d.button.textContent).toBe("1 new post");
    d.listeners["forge:held"]!({ detail: { html: "y,x,a" } });
    expect(d.button.textContent).toBe("2 new posts");
    d.clicks[0]!();
    expect(d.feed.innerHTML).toBe("y,x,a");
  });
});
