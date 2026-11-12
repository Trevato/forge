/** MCP `held` draws the `ui://forge/held` card: a group per theme, a row per issue, and one button that closes the done ones. */
import { expect, test } from "bun:test";
import { CARD_OF_TOOL, CARD_KINDS, cardFor } from "../src/web/studio/cards.ts";

const origin = "https://forge.test";
const read = (approve: number[]) => ({
  says: "3 held; 1 found done on main.",
  themes: [
    { theme: "mcp", issues: [
      { number: 7, title: "Old thing", waiting: 0, kind: "close", reason: "done", why: "on main" },
      { number: 9, title: "Maybe", waiting: 0, kind: "keep", reason: "kept", why: "serves a pillar" },
    ] },
    { theme: "other", issues: [{ number: 12, title: "Stray", waiting: 0, kind: "close", reason: "dropped", why: "x" }] },
  ],
  approve,
  digest: "abc123",
});

test("held is drawn as the Later card", () => {
  expect(CARD_OF_TOOL["held"]).toBe("held");
  expect(CARD_KINDS).toContain("held");
  expect(cardFor("held", read([7]), origin, { repo: "alice/app" })?.title).toBe("Later");
});

test("a group per theme, a row per issue linked to it, done marked", () => {
  const card = cardFor("held", read([7]), origin, { repo: "alice/app" })!;
  expect(card.status).toBe("3 held; 1 found done on main.");
  expect(card.rows.map((r) => [r.label, r.value, r.link])).toEqual([
    ["mcp", "2 held", undefined],
    ["#7 Old thing", "done", `${origin}/alice/app/issues/7`],
    ["#9 Maybe", "", `${origin}/alice/app/issues/9`],
    ["other", "1 held", undefined],
    ["#12 Stray", "", `${origin}/alice/app/issues/12`],
  ]);
});

test("one button, Close N done, applies approve with the read's digest", () => {
  const card = cardFor("held", read([7, 12]), origin, { repo: "alice/app" })!;
  expect(card.actions).toEqual([{ label: "Close 2 done", tool: "held", args: { app: "alice/app", apply: [7, 12], digest: "abc123" } }]);
});

test("no button when nothing is done, and an apply's answer has no card", () => {
  expect(cardFor("held", read([]), origin, { repo: "alice/app" })!.actions).toEqual([]);
  expect(cardFor("held", { says: "Closed 2." }, origin, { repo: "alice/app" })).toBeUndefined();
});

test("a card never offers to close what it does not show: a More row, and the button keeps to the shown", () => {
  const issues = Array.from({ length: 45 }, (_, i) => ({ number: i + 1, title: `T${i + 1}`, waiting: 0, kind: "close", reason: "done", why: "x" }));
  const card = cardFor("held", { says: "s", themes: [{ theme: "t", issues }], approve: issues.map((i) => i.number), digest: "d" }, origin, { repo: "alice/app" })!;
  expect(card.rows.at(-1)).toEqual({ label: "More", value: "5 more not shown" });
  expect(card.actions[0]!.label).toBe("Close 40 done");
  expect(card.actions[0]!.args["apply"]).toEqual(issues.slice(0, 40).map((i) => i.number));
});
