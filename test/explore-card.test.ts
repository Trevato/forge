/** The explore card: the top twenty rows with their numbers, linked only to this forge, escaped by the shared shell. */
import { expect, test } from "bun:test";
import { CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";

const numbers = { forks: 1, ships: 2, awakeHours: 3, apps: 0 };
const many = Array.from({ length: 25 }, (_, n) => ({
  kind: "app",
  name: n === 0 ? "<img src=x onerror=alert(1)>" : `app${n}`,
  url: `/bob/app${n}`,
  description: "",
  numbers,
  repo: { owner: "bob", name: `app${n}` },
  copyable: n === 0,
}));

test("the explore tool draws the explore card", () => {
  expect(CARD_OF_TOOL["explore"]).toBe("explore");
});

test("the card keeps twenty rows, with numbers and links, and Make it yours beside the app", () => {
  const c = cardFor("explore", { query: "", items: many }, "https://forge.test")!;
  expect(c.rows.filter((r) => r.label !== "Make it yours")).toHaveLength(20);
  expect(c.rows[0]).toEqual({
    label: "app · <img src=x onerror=alert(1)>",
    value: "1 forks · 2 ships · 3 h awake",
    link: "https://forge.test/bob/app0",
  });
  expect(c.rows[1]!.link).toBe("https://forge.test/bob/app0/make-it-yours");
  expect(c.rows.filter((r) => r.label === "Make it yours")).toHaveLength(1);
});

test("only a rooted path on this forge becomes a link", () => {
  const away = cardFor(
    "explore",
    { items: [{ kind: "forge", name: "x", url: "https://evil.test/" }, { kind: "app", name: "y", url: "//evil.test" }] },
    "https://forge.test",
  )!;
  expect(away.rows.every((r) => r.link === undefined)).toBe(true);
});
