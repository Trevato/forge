/**
 * The compact card vocabulary (#11956): status line says what the rows share, a row says what
 * differs, a long title is cut with an ellipsis, and `forge_view` has a card.
 */
import { expect, test } from "bun:test";
import { cardFor, clip, TITLE_CHARS, CARD_OF_TOOL } from "../src/web/studio/cards.ts";

const O = "https://forge.test";
const LONG = "word ".repeat(60).trim();
const EVIL = `<img src=x onerror=alert(1)>`;

test("clip keeps short titles, folds whitespace, and cuts long ones on a word with an ellipsis", () => {
  expect(clip("  a \n b ")).toBe("a b");
  expect(clip(undefined)).toBe("");
  const c = clip(LONG);
  expect(c.length).toBeLessThanOrEqual(TITLE_CHARS);
  expect(c.endsWith("…")).toBe(true);
  expect(c).not.toMatch(/\s…$/);
  expect(clip("x".repeat(300)).length).toBe(TITLE_CHARS);
});

test("pulls: the status line counts checks once; rows do not repeat the state", () => {
  const pulls = [
    { number: 1, title: LONG, check: "failed" },
    { number: 2, title: "b", check: "ok", verdict: "approved" },
    { number: 3, title: "c", check: "ok" },
  ];
  const c = cardFor("pulls", { pulls }, O, { repo: "a/b", state: "open" })!;
  expect(c.status).toBe("3 open · 1 red · 2 green");
  expect(c.rows[0]!.label.length).toBeLessThanOrEqual(TITLE_CHARS + 3);
  expect(c.rows.every((r) => !r.value.startsWith("open"))).toBe(true);
  expect(c.rows[1]!.value).toBe("check green · approved");
});

test("issues: a shared state moves to the status line; a mixed list keeps it per row", () => {
  const same = cardFor("issues", { items: [{ number: 1, title: "a", state: "open" }, { number: 2, title: "b", state: "open" }] }, O, { repo: "a/b" })!;
  expect(same.status).toBe("2 open issues");
  expect(same.rows.map((r) => r.value)).toEqual(["", ""]);
  const mixed = cardFor("issues", { items: [{ number: 1, title: "a", state: "open" }, { number: 2, title: "b", state: "closed" }] }, O, { repo: "a/b" })!;
  expect(mixed.status).toBe("2 issues · 1 open · 1 closed");
  expect(mixed.rows.map((r) => r.value)).toEqual(["open", "closed"]);
  const none = cardFor("issues", { items: [] }, O, { repo: "a/b" })!;
  expect(none.status).toBe("0 issues");
});

test("issue: the title is the card's title, clipped, and escaping is left to the shell's textContent", () => {
  const c = cardFor("issue", { number: 7, title: LONG, state: "open", labels: [] }, O, { repo: "a/b" })!;
  expect(c.title.startsWith("#7 ")).toBe(true);
  expect(c.title.endsWith("…")).toBe(true);
  expect(c.rows[0]).toEqual({ label: "On the forge", value: "a/b #7", link: `${O}/a/b/issues/7` });
  expect(cardFor("issue", { number: 8, title: EVIL, state: "open" }, O, { repo: "a/b" })!.title).toBe(`#8 ${EVIL}`);
});

test("pull and runs titles are clipped too; a missing title leaves no dangling space", () => {
  const p = cardFor("pull", { number: 3, title: LONG, state: "open", head: "x", base: "main" }, O, { repo: "a/b" })!;
  expect(p.title.length).toBeLessThanOrEqual(TITLE_CHARS + 3);
  expect(cardFor("pull", { number: 3, state: "open" }, O, { repo: "a/b" })!.title).toBe("#3");
  const r = cardFor("runs", { runs: [{ id: "x", kind: "build", state: "ok", number: 2, title: LONG }] }, O, { repo: "a/b" })!;
  expect(r.rows[0]!.label.endsWith("…")).toBe(true);
});

test("forge_view has a card: verdict and load in the status, busy apps first, quiet ones counted", () => {
  expect(CARD_OF_TOOL["forge_view"]).toBe("forge");
  const view = {
    counts: { apps: 5, running: 3, queued: 1, waiting: 2 },
    apps: [
      { app: "a/quiet", running: 0, queued: 0 },
      { app: "a/one", running: 1, queued: 0 },
      { app: "a/two", running: 2, queued: 1 },
    ],
    runs: [],
    health: { ok: true },
  };
  const c = cardFor("forge_view", view, O)!;
  expect(c.kind).toBe("forge");
  expect(c.status).toBe("healthy · 3 running · 1 queued");
  expect(c.rows.map((r) => r.label)).toEqual(["a/two", "a/one", "Apps", "Waiting"]);
  expect(c.rows[0]).toEqual({ label: "a/two", value: "2 running · 1 queued", link: `${O}/a/two` });
  expect(c.rows[2]!.value).toBe("5 in all");
  expect(c.rows[3]!.value).toBe("2 waiting on you");
  const idle = cardFor("forge_view", { counts: { apps: 0, running: 0, queued: 0, waiting: 0 }, apps: [], runs: [], health: { ok: false } }, "")!;
  expect(idle.status).toBe("needs attention · crew idle");
  expect(idle.rows).toEqual([{ label: "Apps", value: "0 in all · none busy" }]);
  expect(cardFor("forge_view", { nope: 1 }, O)).toBeUndefined();
});
