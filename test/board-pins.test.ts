/** Pinned panels (#2741): pin shows on home under the KPIs in the owner's order, unpin removes, nobody else's pins show. */
import { stylesheetAsset } from "../src/web/asset.ts";
import { refreshJs } from "../src/web/studio/home_last.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeBoard, deleteBoard, writeBoard } from "../src/actions/boards.ts";
import { pinPanel } from "../src/actions/board-pins.ts";
import { MAX_PINS } from "../src/boards/pins.ts";
import { createApp } from "../src/app.ts";
import { listPins, pinOf } from "../src/boards/pins.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir: string;
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let alice: User;
let carol: User;
const tok: Record<string, string> = {};

const panel = (title: string) => ({ title, chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 });
const post = (path: string, fields: Record<string, string>, who = "alice", headers: Record<string, string> = {}) =>
  fetch(servers.url + path, {
    method: "POST", redirect: "manual", body: new URLSearchParams(fields),
    headers: { authorization: `Bearer ${tok[who]}`, ...headers },
  });
const get = async (path: string, who: string) =>
  (await fetch(servers.url + path, { headers: { authorization: `Bearer ${tok[who]}` } })).text();
/** Home as the page's script leaves it: the slot after first paint, then the fragment it fetches. */
const home = async (who: string) => {
  const first = await get("/?all=1", who);
  expect(titles(first)).toEqual([]); // nothing of the charts in the first paint
  return first.includes('data-refresh="/live/home/panels"') ? get("/live/home/panels", who) : "";
};
const titles = (h: string) => [...h.matchAll(/<h2>(Pin [ABC])<\/h2>/g)].map((m) => m[1]);

type Answer = () => Promise<{ ok: boolean; text: () => Promise<string> }>;
/**
 * `refreshJs` run against one slot in a stand-in document: whether the slot still
 * waits (holds its reserve) afterwards, and what its live region holds. The
 * stand-in parses only what the fragment is: a <div> around #home-pins.
 */
async function refreshSlot(answer: Answer): Promise<{ waiting: boolean; pins: string }> {
  const attrs = new Map([["data-refresh", "/live/home/panels"]]);
  const pins = { id: "home-pins", innerHTML: "" };
  const slot = {
    getAttribute: (n: string) => attrs.get(n) ?? null,
    removeAttribute: (n: string) => void attrs.delete(n),
    querySelector: (q: string) => (q === "#home-pins" ? pins : null),
    dispatchEvent: () => true,
    innerHTML: "",
  };
  const template = () => {
    const content: { firstElementChild: unknown } = { firstElementChild: null };
    return {
      content,
      set innerHTML(text: string) {
        const inner = { id: "home-pins", innerHTML: "PANELS" };
        content.firstElementChild = text === "" ? null : { children: [inner], firstElementChild: inner, innerHTML: text };
      },
    };
  };
  const document = { querySelectorAll: () => [slot], createElement: template };
  const window = { fetch: answer, HTMLTemplateElement: function () {} };
  class CustomEvent { constructor(readonly type: string) {} }
  new Function("window", "document", "fetch", "CustomEvent", refreshJs)(window, document, answer, CustomEvent);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return { waiting: attrs.has("data-refresh"), pins: pins.innerHTML };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-board-pins-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, adminIfFirst?: boolean) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  carol = await mk("carol");
  app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [carol.id]);
  const bob = await mk("bob");
  tok.alice = createToken(app.db, alice.id, "t", "admin").token;
  tok.carol = createToken(app.db, carol.id, "t", "admin").token;
  tok.bob = createToken(app.db, bob.id, "t", "admin").token;
  const w = await writeBoard(app, alice, "mine", { title: "Mine", range: "all", refresh: "off", panels: [panel("Pin A"), panel("Pin B"), panel("Pin C")] });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const pinIt = (t: string, who = "alice") => post("/boards/pin-panel", { slug: "mine", title: t, back: "/" }, who);

describe("pinned panels", () => {
  test("pinning shows on home in the owner's order; moving reorders; unpinning removes", async () => {
    expect(titles(await home("alice"))).toEqual([]);
    for (const t of ["Pin A", "Pin B", "Pin C"]) expect((await pinIt(t)).status).toBe(303);
    await pinIt("Pin A"); // twice changes nothing
    expect(titles(await home("alice"))).toEqual(["Pin A", "Pin B", "Pin C"]);
    await post("/boards/move-pin", { slug: "mine", title: "Pin C", by: "-1" });
    await post("/boards/move-pin", { slug: "mine", title: "Pin A", by: "-1" }); // at the top: stays
    expect(titles(await home("alice"))).toEqual(["Pin A", "Pin C", "Pin B"]);
    await post("/boards/unpin-panel", { slug: "mine", title: "Pin C" });
    expect(titles(await home("alice"))).toEqual(["Pin A", "Pin B"]);
  });

  test("home's first paint holds a slot after the KPIs only when something is pinned", async () => {
    const first = await get("/?all=1", "alice");
    expect(first.indexOf('aria-label="The forge"')).toBeLessThan(first.indexOf('id="home-panels"'));
    expect(first.indexOf('id="home-panels"')).toBeLessThan(first.indexOf("live-moving"));
    expect(first).not.toContain("Pinned panels");
    expect(first).toContain('class="home-panels-slot"');
    expect(first).toContain("Open your pinned panels"); // no-script door
    expect(first).toMatch(/id="home-pins"[^>]*data-live="board\.pins"/); // a pin from any door redraws it live
    // The reserve is held only while the slot waits: once the script drops data-refresh, nothing holds it.
    const css = await (await fetch(servers.url + stylesheetAsset().path)).text();
    const rules = [...css.matchAll(/([^{}]*\.home-panels-slot[^{}]*)\{([^}]*)\}/g)].map((m) => [m[1]!.trim(), m[2]!] as const);
    expect(rules.some(([sel, body]) => sel.includes("[data-refresh]") && /min-height/.test(body))).toBe(true);
    expect(rules.some(([sel, body]) => !sel.includes("[data-refresh]") && /min-height/.test(body))).toBe(false);
    const slot = first.match(/<div id="home-panels"[\s\S]*?<\/noscript><\/div>/)?.[0] ?? "";
    expect(slot.length).toBeLessThan(400); // the pins cost home's first paint almost no bytes
    expect(await get("/?all=1", "bob")).not.toContain("home-panels");
    // An admin with no pins: an empty live region to fill, no reserve, no fetch, no link.
    const none = await get("/?all=1", "carol");
    expect(none).toContain('id="home-pins"');
    expect(none).not.toContain('data-refresh="/live/home/panels"');
    expect(none).not.toContain("Open your pinned panels");
  });

  test("the slot is filled when the fragment lands, and collapses when it is empty or fails", async () => {
    const filled = await refreshSlot(async () => ({ ok: true, text: async () => "<div>pins</div>" }));
    expect(filled.pins).toBe("PANELS");
    expect(filled.waiting).toBe(false);
    expect((await refreshSlot(async () => ({ ok: true, text: async () => "" }))).waiting).toBe(false);
    expect((await refreshSlot(async () => ({ ok: false, text: async () => "" }))).waiting).toBe(false);
    expect((await refreshSlot(async () => { throw new Error("offline"); })).waiting).toBe(false);
  });

  test("the pin button is on the board page and flips to Unpin", async () => {
    const page = await (await fetch(servers.url + "/boards/mine", { headers: { authorization: `Bearer ${tok.alice}` } })).text();
    expect(page).toContain("Unpin: Pin A");
    expect(page).toContain("Pin to home: Pin C");
  });

  test("another person's pins never show", async () => {
    expect(titles(await home("carol"))).toEqual([]);
    await pinIt("Pin C", "carol");
    expect(titles(await home("carol"))).toEqual(["Pin C"]);
    expect(titles(await home("alice"))).toEqual(["Pin A", "Pin B"]);
    await post("/boards/unpin-panel", { slug: "mine", title: "Pin A" }, "carol"); // not carol's to unpin
    expect(listPins(app.db, alice.id).map((p) => p.title)).toEqual(["Pin A", "Pin B"]);
  });

  test("refusals: cross-origin, a stranger, an unknown panel, a bad slug", async () => {
    expect((await post("/boards/pin-panel", { slug: "mine", title: "Pin C" }, "alice", { origin: "https://evil.example" })).status).toBe(403);
    expect((await pinIt("Pin C", "bob")).status).toBe(404);
    expect((await pinIt("No such panel")).status).toBe(404);
    expect((await post("/boards/pin-panel", { slug: "../x", title: "Pin A" })).status).toBe(303); // flashed back, nothing stored
    expect(listPins(app.db, alice.id)).toHaveLength(2);
    expect(pinOf("mine", "a\u0000b")).toBeUndefined();
  });

  test("a pin whose panel has gone is skipped, not an error", async () => {
    app.db.run("INSERT INTO board_pin (user_id, slug, title, pos) VALUES (?, 'gone', 'x', 9)", [alice.id]);
    expect(titles(await home("alice"))).toEqual(["Pin A", "Pin B"]);
  });

  test("pins you can't see do not count toward the limit", async () => {
    const many = Array.from({ length: MAX_PINS - 2 }, (_, i) => panel(`Old ${i}`));
    const w = await writeBoard(app, alice, "old", { title: "Old", range: "all", refresh: "off", panels: many });
    expect(w.ok).toBe(true);
    for (const p of many) expect((await pinPanel(app, alice, "old", p.title)).ok).toBe(true);
    expect((await pinPanel(app, alice, "mine", "Pin C")).ok).toBe(false); // full: refused
    await deleteBoard(app, alice, "old"); // every one of those pins now names nothing
    const again = await pinPanel(app, alice, "mine", "Pin C");
    expect(again.ok).toBe(true);
    expect(listPins(app.db, alice.id).map((p) => p.title)).toEqual(["Pin A", "Pin B", "Pin C"]);
    const renamed = await changeBoard(app, alice, "mine", { kind: "edit", index: 2, panel: panel("Pin C2") });
    expect(renamed.ok).toBe(true);
    expect((await pinPanel(app, alice, "mine", "Pin C2")).ok).toBe(true);
    expect(listPins(app.db, alice.id).map((p) => p.title)).toEqual(["Pin A", "Pin B", "Pin C2"]);
  });

  test("the JSON API lists, pins, moves and unpins; others are refused", async () => {
    const api = (who: string, method: string, body?: unknown) =>
      fetch(servers.url + "/api/v1/boards/pins", {
        method, headers: { authorization: `Bearer ${tok[who]}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const titlesOf = async (who: string) => ((await (await api(who, "GET")).json()) as { pins: { title: string }[] }).pins.map((p) => p.title);
    expect(await titlesOf("alice")).toEqual(["Pin A", "Pin B", "Pin C2"]);
    expect((await api("alice", "POST", { op: "move", slug: "mine", title: "Pin C2", by: -1 })).status).toBe(200);
    expect(await titlesOf("alice")).toEqual(["Pin A", "Pin C2", "Pin B"]);
    expect((await api("alice", "POST", { op: "unpin", slug: "mine", title: "Pin A" })).status).toBe(200);
    expect((await api("alice", "POST", { op: "pin", slug: "mine", title: "Pin A" })).status).toBe(200);
    expect(await titlesOf("alice")).toEqual(["Pin C2", "Pin B", "Pin A"]);
    expect((await api("alice", "POST", { op: "pin", slug: "mine", title: "nope" })).status).toBe(404);
    expect((await api("alice", "POST", { op: "dance" })).status).toBe(422);
    expect((await api("bob", "GET")).status).toBe(403);
    expect((await api("bob", "POST", { op: "pin", slug: "mine", title: "Pin A" })).status).toBe(403);
    expect(await titlesOf("carol")).toEqual([]); // her "Pin C" was renamed away: not shown
  });
});
