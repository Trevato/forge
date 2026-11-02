import { expect, test } from "bun:test";
import { cardFor } from "../src/web/studio/cards.ts";
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
