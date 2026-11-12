import { describe, expect, test } from "bun:test";
import { shellJs } from "../src/web/client.ts";
import { components } from "../src/web/style/components.ts";
import {
  frecencyOrder,
  fuzzyScore,
  paletteHelpersJs,
  rankPalette,
  readUses,
  recordUse,
  recordVisit,
  visitRows,
  visitLoad,
  palettePool,
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
    expect(shellJs).toContain("frecencyOrder(uses, openedAt).slice(0, RECENT_SHOWN)");
    expect(shellJs).toContain("RECENT_MAX = 50");
    expect(shellJs).toContain("RECENT_SHOWN = 8");
  });
});

describe("recent visits", () => {
  const rows: PaletteRow[] = ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ t: `Page ${n}`, h: `/${n}`, g: "Go to" }));
  test("a visit is recorded once, newest first, at most max, paths only", () => {
    let v: string[] = [];
    for (const n of ["a", "b", "a", "c"]) v = recordVisit(v, `/${n}`, 3);
    expect(v).toEqual(["/c", "/a", "/b"]);
    expect(recordVisit(v, "/d", 3)).toEqual(["/d", "/c", "/a"]);
    expect(recordVisit(v, "//evil.example", 3)).toEqual(v);
    expect(recordVisit(v, "https://x.example/", 3)).toEqual(v);
  });
  test("the visits list up to five, titled from rows, never the current page", () => {
    const v = ["/a", "/b", "/c", "/d", "/e", "/f", "/g"];
    const got = visitRows(v, rows, "/a", 5);
    expect(got.map((r) => r.h)).toEqual(["/b", "/c", "/d", "/e", "/f"]);
    expect(got[0]).toEqual({ t: "Page b", h: "/b", g: "Recent", d: "Go to" });
  });
  test("a visit with no row, a repeat or a non-string is skipped", () => {
    expect(visitRows(["/zzz", "/b", "/b", 7, "/c"], rows, "/", 5).map((r) => r.h)).toEqual(["/b", "/c"]);
  });
  const use = (h: string, c = 1, l = 1000): PaletteUse => ({ t: `Page ${h.slice(1)}`, h, g: "Go to", c, l });
  test("a load records its page only when the palette has a row for it", () => {
    expect(visitLoad(["/b"], "/a", rows, 6)).toEqual(["/a", "/b"]);
    expect(visitLoad(["/b"], "/login", rows, 6)).toEqual(["/b"]);
  });
  test("empty query: visited pages first, then picked ones, both Recent, never the page you are on", () => {
    const pool = palettePool("", rows, [], ["/c", "/a"], [use("/d", 9), use("/a", 99), use("/e", 1)], "/a", 1000, 5);
    expect(pool.slice(0, 3).map((r) => r.h)).toEqual(["/c", "/d", "/e"]);
    expect(pool.slice(0, 3).every((r) => r.g === "Recent")).toBe(true);
    expect(pool.slice(0, 3).map((r) => r.d)).toEqual(["Go to", "Go to", "Go to"]);
    expect(pool.slice(3)).toEqual(rows);
    const groups = rankPalette(pool, "", [], 24);
    expect(groups[0]!.title).toBe("Recent");
    expect(groups[0]!.rows.map((r) => r.h)).toEqual(["/c", "/d", "/e"]);
  });
  test("the whole Recent group is at most five: visits first, picked rows only fill it", () => {
    const visits = ["/b", "/c", "/d"];
    const uses = ["/e", "/f", "/g", "/a"].map((h, i) => use(h, 10 - i));
    const recent = palettePool("", rows, [], visits, uses, "/", 1000, 5).filter((r) => r.g === "Recent");
    expect(recent.map((r) => r.h)).toEqual(["/b", "/c", "/d", "/e", "/f"]);
    const full = palettePool("", rows, [], ["/a", "/b", "/c", "/d", "/e", "/f"], uses, "/", 1000, 5).filter((r) => r.g === "Recent");
    expect(full.map((r) => r.h)).toEqual(["/a", "/b", "/c", "/d", "/e"]);
  });
  test("a page both visited and picked is listed once, where its visit puts it", () => {
    const pool = palettePool("", rows, [], ["/c", "/b"], [use("/b", 50), use("/d", 1)], "/", 1000, 5);
    const recent = pool.filter((r) => r.g === "Recent");
    expect(recent.map((r) => r.h)).toEqual(["/c", "/b", "/d"]);
    const groups = rankPalette(pool, "", [], 24);
    expect(groups[0]!.rows.filter((r) => r.h === "/b").length).toBe(1);
  });
  test("typing hides every Recent row, keeps the rest and adds served rows from two letters", () => {
    const served: PaletteRow[] = [{ t: "x/y", h: "/x/y", g: "Repositories" }];
    expect(palettePool("p", rows, served, ["/c"], [use("/d")], "/a", 1000, 5)).toEqual(rows);
    const typed = palettePool("pa", rows, served, ["/c"], [use("/d")], "/a", 1000, 5);
    expect(typed).toEqual([...rows, ...served]);
    expect(rankPalette(typed, "page", [], 24).some((g) => g.title === "Recent")).toBe(false);
  });
});

describe("recent visits in the running shell", () => {
  const index = JSON.stringify({ items: ["a", "b", "c"].map((n) => ({ t: `Page ${n}`, h: `/${n}` })) });
  const body = `<script type="application/json" id="palette-index">${index}</script>
    <dialog class="dialog palette" id="palette"><input class="input palette-input" type="text" /><div class="palette-list" id="palette-list"></div></dialog>`;
  /** The shell running on `path` over a localStorage seeded with `stored`, as one page load. */
  async function shellPageWith(path: string, stored: Record<string, string>) {
    const { Window } = await import("happy-dom");
    const win = new Window({ url: `http://forge.test${path}` });
    for (const [k, v] of Object.entries(stored)) win.localStorage.setItem(k, v);
    win.document.body.innerHTML = body;
    (win.HTMLElement.prototype as any).scrollIntoView ??= () => {};
    new Function("document", "window", "location", "sessionStorage", "CSS", "fetch", "EventSource", shellJs)(
      win.document, win, win.location, win.sessionStorage, { escape: (x: string) => x },
      async () => ({ ok: false, status: 500, text: async () => "", headers: { get: () => null } }), undefined,
    );
    const visits = () => JSON.parse(win.localStorage.getItem("forge.palette.visits") ?? "[]");
    const open = () => {
      win.document.dispatchEvent(new win.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true }));
      const doc = win.document as any;
      const groups = [...doc.querySelectorAll("#palette-list .palette-group")].map((g: any) => ({
        title: g.querySelector(".palette-heading")?.textContent,
        hrefs: [...g.querySelectorAll("a")].map((a: any) => a.getAttribute("href")),
      }));
      return groups;
    };
    return { win, visits, open, stored: () => ({ "forge.palette.visits": win.localStorage.getItem("forge.palette.visits") ?? "[]" }) };
  }

  test("each load records its page, and the next page's palette opens on it", async () => {
    let p = await shellPageWith("/a", {});
    expect(p.visits()).toEqual(["/a"]);
    p = await shellPageWith("/b", p.stored());
    expect(p.visits()).toEqual(["/b", "/a"]);
    p = await shellPageWith("/c", p.stored());
    const groups = p.open();
    expect(groups[0]).toEqual({ title: "Recent", hrefs: ["/b", "/a"] });
  });

  test("a page with no palette row is not recorded", async () => {
    const p = await shellPageWith("/login", { "forge.palette.visits": JSON.stringify(["/a"]) });
    expect(p.visits()).toEqual(["/a"]);
  });

  test("storage is read once per opening, not per keystroke", async () => {
    const p = await shellPageWith("/c", { "forge.palette.visits": JSON.stringify(["/c", "/a"]) });
    const real = p.win.localStorage;
    let reads = 0;
    const counting = {
      getItem: (k: string) => { reads++; return real.getItem(k); },
      setItem: (k: string, v: string) => real.setItem(k, v),
      removeItem: (k: string) => real.removeItem(k),
    };
    Object.defineProperty(p.win, "localStorage", { value: counting, configurable: true });
    const groups = p.open();
    expect(groups[0]).toEqual({ title: "Recent", hrefs: ["/a"] });
    const opened = reads;
    expect(opened).toBeGreaterThan(0);
    const input = p.win.document.querySelector(".palette-input") as any;
    for (const ch of ["p", "pa", "pag", ""]) {
      input.value = ch;
      input.dispatchEvent(new p.win.Event("input", { bubbles: true }));
    }
    expect(reads).toBe(opened);
  });
});

describe("the palette's text is readable (#11028)", () => {
  const rule = (sel: string) => components.match(new RegExp(`${sel.replace(/[.\[\]"=]/g, "\\$&")}\\s*\\{[^}]*\\}`))?.[0] ?? "";
  test("headings and row details use --muted-fg, not --faint (2.3:1 on the selected row in light)", () => {
    for (const sel of [".palette-heading", ".palette-item .cat"]) {
      expect(rule(sel)).toContain("color: var(--muted-fg)");
      expect(rule(sel)).not.toContain("--faint");
    }
  });
  test("the selected row's detail reads in --fg: --muted-fg is 4.40:1 on its highlight", () => {
    expect(rule('.palette-item[aria-selected="true"] .cat')).toContain("color: var(--fg)");
  });
});
