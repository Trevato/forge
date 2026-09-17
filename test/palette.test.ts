import { describe, expect, test } from "bun:test";
import { shellJs } from "../src/web/client.ts";
import {
  fuzzyScore,
  paletteHelpersJs,
  rankPalette,
  type PaletteGroup,
  type PaletteRow,
} from "../src/web/palette.ts";

describe("fuzzy score", () => {
  test("the closer the landing, the higher: exact, prefix, word start, substring, letters in order", () => {
    const exact = fuzzyScore("issues", "Issues");
    const prefix = fuzzyScore("issues", "Issues and pulls");
    const wordStart = fuzzyScore("issues", "Open issues");
    const inside = fuzzyScore("issues", "Reissues");
    const scattered = fuzzyScore("isu", "Issues");
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
    expect(scattered).toBeGreaterThan(0);
  });

  test("no landing, no score", () => {
    expect(fuzzyScore("xyz", "Issues")).toBe(0);
    expect(fuzzyScore("sett", "SSH keys")).toBe(0);
    expect(fuzzyScore("issuesx", "Issues")).toBe(0);
  });

  test("case-blind, and an empty query matches everything alike", () => {
    expect(fuzzyScore("ISSUES", "issues")).toBe(fuzzyScore("issues", "ISSUES"));
    expect(fuzzyScore("", "anything")).toBe(1);
    expect(fuzzyScore("   ", "anything")).toBe(1);
  });

  test("every word must land, in any order; adjacent letters beat scattered ones", () => {
    expect(fuzzyScore("nw iss", "New issue")).toBeGreaterThan(0);
    expect(fuzzyScore("issue new", "New issue")).toBeGreaterThan(0);
    expect(fuzzyScore("new pull", "New issue")).toBe(0);
    expect(fuzzyScore("iss", "Issues")).toBeGreaterThan(
      fuzzyScore("ius", "Issues"),
    );
  });

  test("an earlier landing beats a later one", () => {
    expect(fuzzyScore("forge", "trevato/forge")).toBeGreaterThan(
      fuzzyScore("forge", "someone-else/the-other-forge"),
    );
  });
});

const rows: PaletteRow[] = [
  { t: "Home", h: "/", g: "Go to" },
  { t: "New issue", h: "/new-issue", g: "Create" },
  { t: "New repository", h: "/new", g: "Create" },
  { t: "Issues", h: "/ada/engine/issues", g: "This repository" },
  { t: "ada/engine", h: "/ada/engine", g: "Repositories" },
  { t: "ada/issues-tracker", h: "/ada/issues-tracker", g: "Repositories" },
  { t: "SSH keys", h: "/settings/keys", g: "Settings" },
];

const titles = (groups: PaletteGroup[]) =>
  groups.map((g) => [g.title, g.rows.map((r) => r.t)]);

describe("rank palette", () => {
  test("the best row leads its group and the best group leads the list", () => {
    const out = rankPalette(rows, "issue", [], 20);
    expect(out[0]?.title).toBe("This repository");
    expect(out[0]?.rows[0]?.t).toBe("Issues");
    // Prefix beats word start; between two word starts the shorter wins.
    expect(out.flatMap((g) => g.rows.map((r) => r.t))).toEqual([
      "Issues",
      "New issue",
      "ada/issues-tracker",
    ]);
    // "issues" is not "issue": in-order letters, not a stem — so the
    // plural finds the plural and leaves "New issue" alone.
    const plural = rankPalette(rows, "issues", [], 20).flatMap((g) =>
      g.rows.map((r) => r.t),
    );
    expect(plural).toEqual(["Issues", "ada/issues-tracker"]);
  });

  test("an empty query keeps the given order and honours the cap", () => {
    expect(titles(rankPalette(rows, "", [], 100))).toEqual([
      ["Go to", ["Home"]],
      ["Create", ["New issue", "New repository"]],
      ["This repository", ["Issues"]],
      ["Repositories", ["ada/engine", "ada/issues-tracker"]],
      ["Settings", ["SSH keys"]],
    ]);
    const capped = rankPalette(rows, "", [], 3);
    expect(capped.flatMap((g) => g.rows).length).toBe(3);
    expect(titles(capped)).toEqual([
      ["Go to", ["Home"]],
      ["Create", ["New issue", "New repository"]],
    ]);
  });

  test("one row per href — the first wins, so the index beats the server's copy", () => {
    const twice = [
      ...rows,
      { t: "ada/engine (again)", h: "/ada/engine", g: "Repositories" },
    ];
    const flat = rankPalette(twice, "engine", [], 20).flatMap((g) => g.rows);
    expect(flat.filter((r) => r.h === "/ada/engine").map((r) => r.t)).toEqual([
      "ada/engine",
    ]);
  });

  test("a recent pick gets a nudge, not a free pass", () => {
    const plain = rankPalette(rows, "new", [], 20).flatMap((g) => g.rows);
    expect(plain[0]?.t).toBe("New issue");
    const nudged = rankPalette(rows, "new", ["/new"], 20).flatMap(
      (g) => g.rows,
    );
    expect(nudged[0]?.t).toBe("New repository");
    // A recent that does not answer the query is still not shown.
    const absent = rankPalette(rows, "keys", ["/new"], 20).flatMap(
      (g) => g.rows,
    );
    expect(absent.map((r) => r.t)).toEqual(["SSH keys"]);
  });

  test("a detail can carry a row on its own, at half weight", () => {
    const withDetail: PaletteRow[] = [
      {
        t: "src/a.ts:3",
        h: "/ada/engine/blob/HEAD/src/a.ts#L3",
        g: "Code",
        d: "const engine = 1",
      },
      { t: "engine", h: "/engine", g: "Go to" },
    ];
    const out = rankPalette(withDetail, "engine", [], 20).flatMap(
      (g) => g.rows,
    );
    expect(out.map((r) => r.t)).toEqual(["engine", "src/a.ts:3"]);
  });
});

describe("the page runs the same functions", () => {
  test("the shipped JavaScript agrees with the module", () => {
    const shipped = new Function(
      `${paletteHelpersJs}; return { fuzzyScore: fuzzyScore, rankPalette: rankPalette };`,
    )() as { fuzzyScore: typeof fuzzyScore; rankPalette: typeof rankPalette };
    for (const [q, t] of [
      ["nw iss", "New issue"],
      ["issues", "Open issues"],
      ["xyz", "Issues"],
      ["", "x"],
    ] as const) {
      expect(shipped.fuzzyScore(q, t)).toBe(fuzzyScore(q, t));
    }
    for (const q of ["", "issues", "new", "engine"]) {
      expect(shipped.rankPalette(rows, q, ["/new"], 5)).toEqual(
        rankPalette(rows, q, ["/new"], 5),
      );
    }
  });

  test("the shell script carries them, and owns Escape while a dialog is open", () => {
    expect(shellJs).toContain("function fuzzyScore(");
    expect(shellJs).toContain("function rankPalette(");
    expect(shellJs).toContain("function openModal(");
    // Escape is consumed on keydown and the dialog's own cancel is ours.
    expect(shellJs).toMatch(
      /if \(e\.key !== 'Escape'\) return;\s*e\.preventDefault\(\);\s*e\.stopPropagation\(\);/,
    );
    expect(shellJs).toContain(
      "function onCancel(e) { e.preventDefault(); close(); }",
    );
    // The palette's index rides as data; the script never carries runtime text.
    expect(shellJs).not.toContain("${");
  });
});
