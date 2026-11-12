import { expect, test } from "bun:test";
import { CARD_KINDS, CARD_OF_TOOL, CARD_SHELL, CARD_URI, cardFor } from "../src/web/studio/cards.ts";
import { id } from "../src/kernel/id.ts";

const run = id();
const row = { who: "scout", app: "alice/game", on: "#1", state: "going" };

test("now links each run to its page when id and origin are good", () => {
  const card = cardFor("now", [{ ...row, run }, { ...row }], "https://forge.example")!;
  expect(card.rows[0]!.link).toBe(`https://forge.example/alice/game/runs/${run}`);
  expect(card.rows[1]!.link).toBeUndefined();
  expect(card.actions[0]!.tool).toBe("stop");
});

test("now gives no link for a bad origin, id or app", () => {
  for (const [o, r] of [["javascript:x", { ...row, run }], ["", { ...row, run }], ["https://f.example", { ...row, run: "r1" }], ["https://f.example", { ...row, app: "nope", run }]] as const)
    expect(cardFor("now", [r], o)!.rows[0]!.link).toBeUndefined();
});

const EVIL = "<img src=x onerror=1>";

test("now is the ui://forge/crew card, listed and served, apart from the scorecard's", () => {
  expect(CARD_KINDS).toContain("crew");
  expect(CARD_KINDS).toContain("scorecard");
  expect(CARD_OF_TOOL["now"]).toBe("crew");
  expect(CARD_OF_TOOL["scorecard"]).toBe("scorecard");
  expect(CARD_URI("crew")).toBe("ui://forge/crew");
  expect(CARD_SHELL("crew")).toContain("Working now");
});

test("the crew card draws a waiting planner first with its words, every field as text", () => {
  const waiting = { run: null, who: EVIL, app: "alice/game", on: `#2 ${EVIL}`, state: `waiting ${EVIL}`, says: `${EVIL} pick a direction`, since: new Date().toISOString(), costUsd: 0 };
  const card = cardFor("now", [waiting, { ...row, run, costUsd: 1.5 }], "https://forge.example")!;
  expect(card.kind).toBe("crew");
  expect(card.status).toBe("2 going");
  const first = card.rows[0]!;
  expect(first.label).toBe(`${EVIL} on alice/game`);
  expect(first.value).toContain(`#2 ${EVIL} — waiting ${EVIL}`);
  expect(first.value).toContain(`${EVIL} pick a direction`);
  expect(first.link).toBeUndefined();
  expect(card.rows[1]!.value).toContain("$1.50");
  expect(card.actions.length).toBe(1);
});

test("the crew card cuts a long saying and gives words only to rows with no run", () => {
  const long = cardFor("now", [{ run: null, who: "the planner", app: "a/b", state: "waiting for you", says: "w".repeat(500) }])!;
  expect(long.rows[0]!.value.length).toBeLessThan(260);
  const running = cardFor("now", [{ ...row, run, says: "should not show" }], "https://forge.example")!;
  expect(running.rows[0]!.value).not.toContain("should not show");
});

test("the scorecard keeps its own card", () => {
  const card = cardFor("scorecard", { agents: [{ username: "scout", week: { merged: 2, returned: 0, cost: 1 } }], keeperDays: [] })!;
  expect(card.kind).toBe("scorecard");
  expect(card.rows[0]!.label).toBe("scout");
});
