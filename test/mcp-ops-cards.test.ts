/** restore_drill, scorecard, reports and usage answer with a card beside their unchanged JSON. */
import { expect, test } from "bun:test";
import { CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";

test("restore_drill: verdict in one word, the failed step, when", () => {
  expect(CARD_OF_TOOL["restore_drill"]).toBe("drill");
  const at = new Date(Date.now() - 3 * 3600_000).toISOString();
  const red = cardFor("restore_drill", { verdict: "red", failedStep: "<b>boot</b>", says: "The drill failed at boot." }, "", { at })!;
  expect(red.rows).toEqual([
    { label: "Verdict", value: "red" },
    { label: "Failed step", value: "<b>boot</b>" },
    { label: "When", value: "3h ago" },
  ]);
  const green = cardFor("restore_drill", { verdict: "green", says: "ok" })!;
  expect(green.rows).toEqual([{ label: "Verdict", value: "green" }]);
  expect(cardFor("restore_drill", { nope: 1 })).toBeUndefined();
});

test("scorecard: one row per member, the landed number and red rate beside the week", () => {
  const agents = [
    { username: "torque", all: { landed: 12, redCheckRate: 0.25 }, recent: null, week: { merged: 3, returned: 1, cost: 4.5 } },
    { username: "idle", all: null, recent: null, week: { merged: 0, returned: 0, cost: 0 } },
  ];
  const card = cardFor("scorecard", { agents, keeperDays: [] })!;
  expect(card.rows).toEqual([
    { label: "torque", value: "12 landed · 25% red · 3 merged · 1 returned · $4.50 this week" },
    { label: "idle", value: "0 merged · 0 returned · $0.00 this week" },
  ]);
});

test("reports: one row per report, its state, linked to the repository's reports", () => {
  const value = { says: "2 reports waiting", byAgent: [], items: [
    { id: "a", title: "Broken <link>", state: "waiting", filedBy: "anonymous" },
    { id: "b", title: "", state: "waiting", filedBy: "signed" },
  ] };
  const card = cardFor("reports", value, "https://f.test", { repo: "alice/engine" })!;
  expect(card.status).toBe("2 reports waiting");
  expect(card.rows[0]).toEqual({ label: "Broken <link>", value: "waiting · anonymous", link: "https://f.test/alice/engine/reports" });
  expect(card.rows[1]!.label).toBe("(untitled)");
  expect(cardFor("reports", { id: "a", state: "dismissed" }, "https://f.test", { repo: "alice/engine" })).toBeUndefined();
  expect(cardFor("reports", value, "https://f.test", { repo: "nowhere" })!.rows[0]!.link).toBeUndefined();
});

test("usage: the window's figures as rows, for a repo and for the forge", () => {
  const span = { runs: 2, tokensIn: 100, tokensOut: 50, costUsd: 1.234 };
  const repo = cardFor("usage", { app: "a/b", days: 7, total: span, byAgent: [{ agent: "torque", ...span }] })!;
  expect(repo.status).toBe("a/b · 7 days");
  expect(repo.rows).toEqual([
    { label: "Total", value: "2 runs · $1.23 · 150 tokens" },
    { label: "torque", value: "2 runs · $1.23 · 150 tokens", depth: 1 },
  ]);
  const forge = cardFor("usage", { apps: 3, today: span, last24h: span, subscriptions: [
    { subscription: "main", today: span, last24h: span, headroom: [{ window: "5h", pct: 40, resetsAt: null }, { window: "week", pct: null, resetsAt: null }] },
  ] })!;
  expect(forge.status).toBe("3 apps");
  expect(forge.rows[2]!.value).toBe("2 runs · $1.23 · 150 tokens today · headroom 5h 40% · week ?");
  expect(cardFor("usage", { nope: 1 })).toBeUndefined();
});
