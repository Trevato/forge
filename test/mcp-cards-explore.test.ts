/**
 * MCP `forks` draws `ui://forge/forks`, `explore` (ranked or `kind: tree`) `ui://forge/explore`,
 * `feed` `ui://forge/feed`: linked rows, escaped, with and without rows.
 */
import { describe, expect, test } from "bun:test";
import { CARD_OF_TOOL, cardFor } from "../src/web/studio/cards.ts";

const O = "https://forge.test";
const EVIL = "<img src=x onerror=1>";

describe("forks and explore tree cards", () => {
  test("forks is bound to the forks card", () => {
    expect(CARD_OF_TOOL["forks"]).toBe("forks");
  });

  test("a forks page: one linked row per fork with ahead and behind, unknown said so", () => {
    const c = cardFor("forks", { parent: "a/b", forks: [{ repo: "c/d", ahead: 2, behind: 1, updatedAt: null }, { repo: EVIL, ahead: null, behind: null, updatedAt: null }], next_cursor: null }, O)!;
    expect(c.kind).toBe("forks");
    expect(c.status).toBe("2 forks of a/b");
    expect(c.rows[0]).toEqual({ label: "c/d", value: "2 ahead · 1 behind", link: `${O}/c/d` });
    expect(c.rows[1]!.value).toBe("standing unknown");
    expect(c.rows[1]!.link).toBeUndefined();
    expect(c.rows[1]!.label).toBe(EVIL);
  });

  test("no forks: a card with no rows; a next cursor says more exist", () => {
    const c = cardFor("forks", { parent: null, forks: [], next_cursor: null }, O)!;
    expect(c.status).toBe("0 forks");
    expect(c.rows).toEqual([]);
    expect(cardFor("forks", { parent: null, forks: [{ repo: "c/d", ahead: 0, behind: 0 }], next_cursor: "x" }, O)!.rows).toHaveLength(2);
  });

  test("a chain: role and how it follows, linked", () => {
    const c = cardFor("forks", { chain: [{ role: "parent", repo: "a/b", follows: "Follows nothing", page: "/a/b" }, { role: "this", repo: "c/d", follows: "takes updates", page: "/c/d" }], severed: false, truncated: false }, O)!;
    expect(c.rows[1]).toEqual({ label: "c/d", value: "this · takes updates", link: `${O}/c/d` });
    expect(cardFor("forks", { chain: [], severed: false, truncated: false }, O)!.rows).toEqual([]);
  });

  test("explore kind tree: upstream first, then itself and its forks, drawn as the explore card", () => {
    const row = (repo: string, follows: string, standing: string | null) => ({ repo, follows, standing, updatedAt: null });
    const c = cardFor("explore", { app: row("c/d", "takes updates", "1 ahead · 0 behind"), upstream: [row("a/b", "follows nothing", null)], forks: [row(EVIL, "off", "standing unknown")], truncated: true }, O)!;
    expect(c.kind).toBe("explore");
    expect(c.rows.map((r) => r.label)).toEqual(["a/b", "c/d", EVIL, "More"]);
    expect(c.rows[1]!.value).toBe("this · takes updates · 1 ahead · 0 behind");
    expect(c.rows[0]!.link).toBe(`${O}/a/b`);
    const none = cardFor("explore", { app: row("c/d", "off", null), upstream: [], forks: [], truncated: false }, O)!;
    expect(none.rows).toHaveLength(1);
  });

  test("a ranked explore answer still draws the ranked card", () => {
    expect(cardFor("explore", { query: "", items: [] }, O)!.status).toBe("0 ranked");
  });

  test("a severed chain says so in a row and the status", () => {
    const c = cardFor("forks", { chain: [{ role: "this", repo: "c/d", follows: "off" }], severed: true, truncated: false }, O)!;
    expect(c.status).toBe("1 in the chain · severed");
    expect(c.rows.at(-1)!.label).toBe("Severed");
  });

  test("over 30 forks: 30 rows and one More row with the count", () => {
    const forks = Array.from({ length: 31 }, (_, i) => ({ repo: `o/f${i}`, ahead: 0, behind: 0 }));
    const c = cardFor("forks", { parent: null, forks, next_cursor: null }, O)!;
    expect(c.rows).toHaveLength(31);
    expect(c.rows[30]).toEqual({ label: "More", value: "1 more not shown" });
  });

  test("over 30 and paged on: still one More row, with the count and the hint", () => {
    const forks = Array.from({ length: 32 }, (_, i) => ({ repo: `o/f${i}`, ahead: 0, behind: 0 }));
    const c = cardFor("forks", { parent: null, forks, next_cursor: "x" }, O)!;
    expect(c.rows.filter((r) => r.label === "More")).toEqual([{ label: "More", value: "2 more not shown; more forks exist; page on with the tool" }]);
  });

  test("a truncated chain ends in one More row", () => {
    const c = cardFor("forks", { chain: [{ role: "this", repo: "c/d", follows: "off" }], severed: false, truncated: true }, O)!;
    expect(c.rows.at(-1)).toEqual({ label: "More", value: "more forks exist; page on with the tool" });
  });

  test("feed with rows: linked and escaped; with none: an empty card", () => {
    const c = cardFor("feed", { items: [{ actor: "a", what: EVIL, link: "/a/b", app: "a/b", at: "" }], new: 1 }, O)!;
    expect(c.kind).toBe("feed");
    expect(c.status).toBe("1 new since you last looked");
    expect(c.rows[0]).toEqual({ label: `a: ${EVIL}`, value: "a/b", link: `${O}/a/b` });
    const none = cardFor("feed", { items: [] }, O)!;
    expect(none.kind).toBe("feed");
    expect(none.rows).toEqual([]);
  });

  test("explore ranked with rows draws linked rows", () => {
    const c = cardFor("explore", { query: "", items: [{ kind: "app", name: EVIL, url: "/a/b", numbers: { forks: 1, ships: 2, awakeHours: 3 } }] }, O)!;
    expect(c.rows[0]).toEqual({ label: `app · ${EVIL}`, value: "1 forks · 2 ships · 3 h awake", link: `${O}/a/b` });
  });
});
