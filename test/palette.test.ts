import { describe, expect, test } from "bun:test";
import { shellJs } from "../src/web/client.ts";
import {
  frecencyOrder,
  fuzzyScore,
  paletteHelpersJs,
  rankPalette,
  readUses,
  recordUse,
  type PaletteUse,
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

describe("frecency", () => {
  const now = Date.UTC(2026, 10, 10);
  const day = 24 * 3600 * 1000;
  const u = (h: string, c: number, ago: number) => ({ t: h, h, g: "", c, l: now - ago });

  test("recent and frequent both beat old and rare", () => {
    const order = frecencyOrder([u("/old", 1, 60 * day), u("/often", 6, 7 * day), u("/now", 1, 0)], now).map((x) => x.h);
    // /often: 6 × 0.5 = 3; /now: 1; /old: ~0.003
    expect(order).toEqual(["/often", "/now", "/old"]);
  });

  test("a hand calculation: 4 openings two weeks ago equal one opening now", () => {
    const order = frecencyOrder([u("/a", 4, 14 * day), u("/b", 1, 1 * day)], now).map((x) => x.h);
    // /a: 4 × 0.25 = 1; /b: 2^(-1/7) ≈ 0.906
    expect(order).toEqual(["/a", "/b"]);
  });

  test("ties go to the later opening; the input is not mutated", () => {
    const input = [u("/x", 1, 0), u("/y", 1, 0)].map((e, i) => ({ ...e, l: now - i }));
    const out = frecencyOrder(input, now);
    expect(out.map((x) => x.h)).toEqual(["/x", "/y"]);
    expect(out).not.toBe(input);
  });

  test("the helpers ride in the shell script", () => {
    for (const f of ["frecencyOrder", "readUses", "recordUse"]) expect(paletteHelpersJs).toContain(`function ${f}`);
  });
});

describe("recording uses", () => {
  const row = (h: string) => ({ t: h, h, g: "Go to" });

  test("opening a row again raises its count and moves its time", () => {
    const a = recordUse([], row("/a"), 1000, 50);
    const b = recordUse(a, row("/a"), 2000, 50);
    expect(b).toEqual([{ t: "/a", h: "/a", g: "Go to", c: 2, l: 2000 }]);
  });

  test("at most 50 are kept, and the least useful one falls off", () => {
    let uses: PaletteUse[] = [];
    for (let i = 0; i < 60; i++) uses = recordUse(uses, row("/r" + i), 1000 + i, 50);
    expect(uses.length).toBe(50);
    expect(uses[0]!.h).toBe("/r59");
    expect(uses.some((u) => u.h === "/r0")).toBe(false);
  });

  test("a often-opened old row survives the cap over once-opened newer ones", () => {
    let uses = recordUse([], row("/keep"), 1000, 3);
    uses = recordUse(uses, row("/keep"), 1001, 3);
    uses = recordUse(uses, row("/keep"), 1002, 3);
    for (let i = 0; i < 5; i++) uses = recordUse(uses, row("/n" + i), 2000 + i, 3);
    expect(uses.map((u) => u.h)).toContain("/keep");
  });

  test("legacy entries (no count or time) read as one opening; junk and off-origin links drop", () => {
    const raw = [{ t: "A", h: "/a", g: "x" }, { t: "B", h: "https://evil.example/" }, { h: "/c" }, null, "s", { t: "D", h: "/d", c: -4, l: "no" }];
    expect(readUses(raw, 50)).toEqual([
      { t: "A", h: "/a", g: "x", c: 1, l: 1 },
      { t: "D", h: "/d", g: "", c: 1, l: 1 },
    ]);
    expect(readUses("nope", 50)).toEqual([]);
    expect(readUses(raw, 1).length).toBe(1);
  });

  test("the shell script remembers through the helpers, and lists 8", () => {
    expect(shellJs).toContain("recordUse(readRecent()");
    expect(shellJs).toContain("frecencyOrder(readRecent(), Date.now()).slice(0, RECENT_SHOWN)");
    expect(shellJs).toContain("RECENT_MAX = 50");
    expect(shellJs).toContain("RECENT_SHOWN = 8");
  });
});
