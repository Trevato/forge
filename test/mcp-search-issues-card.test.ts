/** MCP `search` and `issues` draw ui:// cards: one row per hit or issue, linked, escaped by the shell, marks kept. */
import { describe, expect, test } from "bun:test";
import { CARD_KINDS, CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";

const origin = "https://forge.test";

describe("search card", () => {
  test("is registered", () => {
    expect(CARD_OF_TOOL["search"]).toBe("search");
    expect(CARD_KINDS).toContain("search");
  });
  test("one linked row per hit, the query on top", () => {
    const card = cardFor("search", {
      repos: [{ source: "local", owner: "a", name: "b", description: "d" }],
      issues: [
        { source: "local", repo: { owner: "a", name: "b" }, number: 3, kind: "issue", title: "<b>x</b>", state: "open" },
        { source: "local", repo: { owner: "a", name: "b" }, number: 4, kind: "pull", title: "p", state: "closed" },
        { source: "origin", fullName: "o/r", number: 1, kind: "issue", title: "far", state: "open", htmlUrl: "javascript:alert(1)" },
      ],
      code: [{ repo: { owner: "a", name: "b" }, path: "src/x.ts", line: 9, text: "  hit  " }],
    }, origin, { q: "needle" })!;
    expect(card.title).toBe("Search: needle");
    expect(card.status).toBe("5 hits");
    expect(card.rows.map((r) => r.link)).toEqual([
      "https://forge.test/a/b", "https://forge.test/a/b/issues/3", "https://forge.test/a/b/pulls/4", undefined, "https://forge.test/a/b",
    ]);
    expect(card.rows[1]!.label).toBe("issue #3 <b>x</b>");
    expect(card.rows[4]!.value).toBe("hit");
  });
});

describe("issues card", () => {
  test("is registered", () => {
    expect(CARD_OF_TOOL["issues"]).toBe("issues");
    expect(CARD_KINDS).toContain("issues");
  });
  test("state, pillar, waits on, untrusted, linked", () => {
    const card = cardFor("issues", {
      items: [
        { number: 5, title: "t", state: "open", untrusted: true },
        { number: 6, title: "u", state: "closed" },
      ],
      next_cursor: "6",
    }, origin, { repo: "a/b", pillars: { "5": "P1" }, waits: { "5": [2, 3] } })!;
    expect(card.rows[0]).toEqual({ label: "#5 t", value: "open · P1 · waits on #2 #3 · untrusted", link: "https://forge.test/a/b/issues/5" });
    expect(card.rows[1]!.value).toBe("closed");
    expect(card.status).toBe("2+ issues · 1 open · 1 closed");
  });
});
