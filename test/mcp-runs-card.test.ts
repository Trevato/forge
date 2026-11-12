import { expect, test } from "bun:test";
import { CARD_SHELL, cardFor } from "../src/web/studio/cards.ts";

const ID = "01m23vygyffx5hg2f5vm8r74sr";
const hostile = `<img src=x onerror=alert(1)>"'`;
const now = Date.now();
const runs = [
  { id: ID, kind: "agent", state: "running", number: 7, title: hostile, startedAt: new Date(now - 125_000).toISOString(), endedAt: null },
  { id: ID, kind: "check", state: "failed", number: 8, title: "b", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:03:00.000Z" },
];

test("runs card: a row per run, newest first, state word and glyph, duration, link", () => {
  const card = cardFor("runs", { runs }, "https://f.example", { repo: "a/b" })!;
  expect(card.kind).toBe("runs");
  expect(card.status).toBe("1 failed · 1 running · 2 runs");
  expect(card.rows[0]!.label).toBe(`▶ agent #7 ${hostile}`);
  expect(card.rows[0]!.value).toBe("running · running for 2m");
  expect(card.rows[1]!.value).toBe("failed · 3m");
  // Failed leads the status line, and the failed row's value begins with the word.
  expect(card.status!.startsWith("1 failed")).toBe(true);
  expect(card.rows[1]!.value.startsWith("failed")).toBe(true);
  expect(card.rows[1]!.label.startsWith("✗ check #8")).toBe(true);
  expect(card.rows[0]!.link).toBe(`https://f.example/a/b/runs/${ID}`);
});

test("runs card: a hostile title stays data and the shell never uses innerHTML", () => {
  const card = cardFor("runs", { runs }, "https://f.example", { repo: "a/b" })!;
  expect(JSON.parse(JSON.stringify(card)).rows[0].label).toContain(hostile);
  expect(CARD_SHELL("runs")).not.toContain("innerHTML");
  expect(CARD_SHELL("runs")).not.toContain(hostile);
});

test("runs card: a bad id or repo gets no link", () => {
  const bad = cardFor("runs", { runs: [{ ...runs[0], id: "../x" }] }, "https://f.example", { repo: "a/b" })!;
  expect(bad.rows[0]!.link).toBeUndefined();
});
