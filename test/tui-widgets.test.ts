import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/git/diff.ts";
import { chord, binding, matches } from "../src/tui/app/keys.ts";
import { rank, score } from "../src/tui/app/palette.ts";
import type { KeyEvent } from "../src/tui/term/input.ts";
import { Screen } from "../src/tui/term/screen.ts";
import { PLAIN, style, UNDERLINE } from "../src/tui/term/style.ts";
import { renderFileDiff } from "../src/tui/ui/diff.ts";
import {
  center,
  fill,
  inset,
  len,
  min,
  pct,
  split,
} from "../src/tui/ui/layout.ts";
import { lineText, renderMarkdown } from "../src/tui/ui/markdown.ts";
import { Textarea } from "../src/tui/ui/textarea.ts";
import { theme } from "../src/tui/ui/theme.ts";
import {
  badge,
  button,
  card,
  emptyState,
  helpBar,
  initials,
  input,
  readableOn,
  row,
  scrollbar,
  segmented,
  table,
  tabs,
  timelineItem,
} from "../src/tui/ui/widgets.ts";
import { galleryFrame } from "../src/tui/gallery.ts";

const c = theme("dark").c;

function surface(cols: number, rows: number): Screen {
  const s = new Screen(cols, rows);
  s.clear(style(c.fg, c.bg));
  return s;
}

const key = (k: string, mods: Partial<KeyEvent> = {}): KeyEvent => ({
  type: "key",
  key: k,
  ctrl: false,
  alt: false,
  shift: false,
  ...mods,
});

describe("layout", () => {
  const area = { x: 0, y: 0, w: 100, h: 10 };

  test("fixed, percentage and fill sum to exactly the available size", () => {
    const parts = split(area, "h", [len(20), pct(30), fill(1)]);
    expect(parts.map((p) => p.w)).toEqual([20, 30, 50]);
    expect(parts.map((p) => p.x)).toEqual([0, 20, 50]);
  });

  test("largest-remainder rounding never leaves a gap at odd widths", () => {
    for (let w = 1; w <= 200; w++) {
      const parts = split({ x: 0, y: 0, w, h: 1 }, "h", [
        fill(1),
        fill(1),
        fill(1),
      ]);
      expect(parts.reduce((n, p) => n + p.w, 0)).toBe(w);
      expect(parts[0]!.x).toBe(0);
      expect(parts[2]!.x + parts[2]!.w).toBe(w);
    }
  });

  test("weighted fills split in proportion", () => {
    expect(split(area, "h", [fill(3), fill(1)]).map((p) => p.w)).toEqual([
      75, 25,
    ]);
  });

  test("min claims its floor before fills share the rest", () => {
    expect(split(area, "h", [min(40), fill(1)]).map((p) => p.w)).toEqual([
      40, 60,
    ]);
  });

  test("an over-committed split clips instead of going negative", () => {
    const parts = split({ x: 0, y: 0, w: 10, h: 1 }, "h", [len(8), len(8)]);
    expect(parts.map((p) => p.w)).toEqual([8, 2]);
    for (const p of parts) expect(p.w).toBeGreaterThanOrEqual(0);
  });

  test("vertical splits carry x and width through", () => {
    const parts = split({ x: 5, y: 0, w: 20, h: 9 }, "v", [
      len(1),
      fill(1),
      len(1),
    ]);
    expect(parts.map((p) => [p.y, p.h])).toEqual([
      [0, 1],
      [1, 7],
      [8, 1],
    ]);
    expect(parts.every((p) => p.x === 5 && p.w === 20)).toBe(true);
  });

  test("inset and center clamp rather than overflow", () => {
    expect(inset({ x: 0, y: 0, w: 4, h: 4 }, 3)).toEqual({
      x: 3,
      y: 3,
      w: 0,
      h: 0,
    });
    expect(center(area, 20, 4)).toEqual({ x: 40, y: 3, w: 20, h: 4 });
    expect(center(area, 500, 500)).toEqual({ x: 0, y: 0, w: 100, h: 10 });
  });
});

describe("widget snapshots", () => {
  test("button variants", () => {
    const s = surface(20, 3);
    button(s, { x: 0, y: 0, w: 20, h: 1 }, c, { label: "Merge" });
    button(s, { x: 0, y: 1, w: 20, h: 1 }, c, {
      label: "Cancel",
      variant: "outline",
    });
    button(s, { x: 0, y: 2, w: 20, h: 1 }, c, {
      label: "Delete",
      variant: "danger",
      focused: true,
    });
    expect(s.toText()).toBe(
      ["       Merge", "     [ Cancel ]", "▸      Delete"].join("\n"),
    );
    // Focus is a shape and an underline, not colour alone — it survives a
    // 16-colour client and a colour-blind reader.
    expect(s.styleAt(8, 2).attr & UNDERLINE).toBe(UNDERLINE);
  });

  test("badge variants carry meaning, not decoration", () => {
    const s = surface(40, 1);
    let x = 0;
    x = badge(s, x, 0, c, { text: "open", variant: "success" }) + 1;
    x = badge(s, x, 0, c, { text: "merged", variant: "merged" }) + 1;
    badge(s, x, 0, c, { text: "closed", variant: "danger" });
    expect(s.toText()).toBe(" open   merged   closed");
    expect(s.styleAt(1, 0).bg).toBe(c.success);
    expect(s.styleAt(8, 0).bg).toBe(c.merged);
    expect(s.styleAt(17, 0).bg).toBe(c.danger);
  });

  test("row shows state, secondary text and right-aligned meta", () => {
    const s = surface(40, 2);
    row(s, { x: 0, y: 0, w: 40, h: 1 }, c, {
      title: "trevato/forge",
      state: "open",
      secondary: "a forge",
      meta: "2m",
      selected: true,
    });
    row(s, { x: 0, y: 1, w: 40, h: 1 }, c, {
      title: "trevato/old",
      state: "closed",
      meta: "1y",
    });
    expect(s.toText()).toBe(
      [
        "▸ ● trevato/forge a forge             2m",
        "  ● trevato/old                       1y",
      ].join("\n"),
    );
    expect(s.styleAt(2, 0).fg).toBe(c.success);
    expect(s.styleAt(2, 1).fg).toBe(c.danger);
  });

  test("table pads columns, right-aligns numbers and keeps a gutter", () => {
    const s = surface(30, 5);
    table(s, { x: 0, y: 0, w: 30, h: 5 }, c, {
      columns: [
        { header: "#", width: len(5), numeric: true },
        { header: "Title", width: fill(1) },
        { header: "+", width: len(6), numeric: true },
      ],
      rows: [
        ["42", "Cell diff", "812"],
        ["7", "Widths", "9"],
      ],
      selected: 0,
    });
    expect(s.toText().split("\n")).toEqual([
      "   # Title                   +",
      "──────────────────────────────",
      "  42 Cell diff             812",
      "   7 Widths                  9",
      "",
    ]);
  });

  test("tabs underline the active one and pill its count", () => {
    const s = surface(30, 2);
    tabs(s, { x: 0, y: 0, w: 30, h: 2 }, c, {
      items: [{ label: "Issues", count: 3 }, { label: "Pulls" }],
      active: 0,
    });
    const lines = s.toText().split("\n");
    expect(lines[0]).toBe(" Issues  3   Pulls");
    expect(lines[1]!.startsWith("━━━━━━━━━━━")).toBe(true);
  });

  test("segmented marks exactly one choice", () => {
    const s = surface(20, 1);
    segmented(s, { x: 0, y: 0, w: 20, h: 1 }, c, {
      items: ["Unified", "Split"],
      active: 1,
    });
    expect(s.toText()).toBe(" Unified  Split");
    expect(s.styleAt(11, 0).bg).toBe(c.primary);
    expect(s.styleAt(2, 0).bg).toBe(c.muted);
  });

  test("card returns a padded interior inside a hairline frame", () => {
    const s = surface(20, 4);
    const inner = card(s, { x: 0, y: 0, w: 20, h: 4 }, c, {
      title: "Repos",
      footer: "4",
    });
    expect(inner).toEqual({ x: 2, y: 1, w: 16, h: 2 });
    s.text(inner.x, inner.y, "content", style(c.fg, c.card));
    expect(s.toText().split("\n")).toEqual([
      "╭─ Repos ──────────╮",
      "│ content          │",
      "│                  │",
      "╰────────────── 4 ─╯",
    ]);
  });

  test("input scrolls horizontally from the caret and reports its position", () => {
    const s = surface(16, 1);
    const pos = input(s, { x: 0, y: 0, w: 16, h: 1 }, c, {
      value: "a-very-long-branch-name",
      cursor: 23,
      focused: true,
    });
    expect(s.toText()).toBe("▏ -branch-name");
    expect(pos).toEqual({ x: 14, y: 0 });
  });

  test("input marks an invalid field on its edge, not with a colour swap", () => {
    const s = surface(16, 1);
    input(s, { x: 0, y: 0, w: 16, h: 1 }, c, { value: "x", invalid: true });
    expect(s.styleAt(0, 0).fg).toBe(c.danger);
  });

  test("empty state is one mark, one headline, one sentence, one action", () => {
    const s = surface(40, 8);
    emptyState(s, { x: 0, y: 0, w: 40, h: 8 }, c, {
      title: "No open issues",
      body: "Everything's closed.",
      action: "New issue",
    });
    expect(
      s
        .toText()
        .split("\n")
        .filter((l) => l !== ""),
    ).toEqual([
      "                   ○",
      "             No open issues",
      "          Everything's closed.",
      "               New issue",
    ]);
  });

  test("scrollbar appears only when there is something to scroll", () => {
    const short = surface(1, 5);
    scrollbar(short, { x: 0, y: 0, w: 1, h: 5 }, c, { total: 3, offset: 0 });
    expect(short.toText().trim()).toBe("");
    const long = surface(1, 5);
    scrollbar(long, { x: 0, y: 0, w: 1, h: 5 }, c, { total: 50, offset: 45 });
    expect(long.toText().split("\n")).toEqual(["░", "░", "░", "░", "█"]);
  });

  test("timeline items thread a rule under the author line", () => {
    const s = surface(34, 3);
    timelineItem(s, { x: 0, y: 0, w: 34, h: 3 }, c, {
      kind: "comment",
      actor: "trevato",
      when: "2m ago",
      body: ["looks good", "shipping"],
    });
    expect(s.toText().split("\n")).toEqual([
      "TR trevato 2m ago",
      " │ looks good",
      " │ shipping",
    ]);
  });

  test("avatar initials and readable foregrounds", () => {
    expect(initials("trevato")).toBe("TR");
    expect(initials("forge bot")).toBe("FB");
    expect(initials("a")).toBe("A ");
    expect(readableOn(0xffffff)).toBe(0x18181b);
    expect(readableOn(0x000000)).toBe(0xfafafa);
  });

  test("help bar is derived from bindings and truncates in priority order", () => {
    const s = surface(24, 1);
    helpBar(s, { x: 0, y: 0, w: 24, h: 1 }, c, [
      binding("j", "next"),
      binding("k", "prev"),
      binding("enter", "open"),
      binding("x", "hidden one", { hidden: true }),
    ]);
    expect(s.toText()).toBe("  j  next   k  prev   …");
  });
});

describe("key bindings", () => {
  test("chords spell out modifiers, and shift only for named keys", () => {
    expect(chord(key("d", { ctrl: true }))).toBe("ctrl+d");
    expect(chord(key("tab", { shift: true }))).toBe("shift+tab");
    expect(chord(key("A", { shift: true }))).toBe("A");
    expect(chord(key("up", { ctrl: true, alt: true }))).toBe("ctrl+alt+up");
  });

  test("a disabled binding never matches, so help and routing agree", () => {
    const b = binding(["m"], "merge", { disabled: true });
    expect(matches(b, key("m"))).toBe(false);
    expect(matches(binding(["m"], "merge"), key("m"))).toBe(true);
  });
});

describe("the fuzzy scorer", () => {
  test("word starts and consecutive runs win", () => {
    const cmds = ["Open pull request", "Open repository", "Copy clone URL"].map(
      (title, i) => ({ id: String(i), title, run: () => {} }),
    );
    expect(rank(cmds, "pull")[0]!.command.title).toBe("Open pull request");
    expect(rank(cmds, "ccu")[0]!.command.title).toBe("Copy clone URL");
    expect(rank(cmds, "zzz")).toEqual([]);
  });

  test("matched indices come back so the list can highlight them", () => {
    expect(score("frg", "forge")).toEqual({
      score: expect.any(Number),
      indices: [0, 2, 3],
    });
    expect(score("", "anything")!.indices).toEqual([]);
    expect(score("xyz", "abc")).toBeNull();
  });
});

describe("textarea", () => {
  test("typing, newlines and backspace across a line join", () => {
    const t = new Textarea("");
    for (const ch of "hi") t.key(key(ch));
    t.key(key("enter"));
    for (const ch of "there") t.key(key(ch));
    expect(t.value).toBe("hi\nthere");
    expect([t.row, t.col]).toEqual([1, 5]);
    for (let i = 0; i < 6; i++) t.key(key("backspace"));
    expect(t.value).toBe("hi");
    expect([t.row, t.col]).toEqual([0, 2]);
  });

  test("a paste is spliced in one edit, never character by character", () => {
    const t = new Textarea("start ");
    t.key(key("end"));
    expect(t.paste("one\ntwo")).toBe("changed");
    expect(t.value).toBe("start one\ntwo");
    expect([t.row, t.col]).toEqual([1, 3]);
  });

  test("word motions and ctrl+w", () => {
    const t = new Textarea("alpha beta gamma");
    t.key(key("end"));
    t.key(key("left", { alt: true }));
    expect(t.col).toBe(11);
    t.key(key("w", { ctrl: true }));
    expect(t.value).toBe("alpha beta gamma".replace("beta ", ""));
    t.key(key("right", { alt: true }));
    expect(t.col).toBeGreaterThan(0);
  });

  test("home and end are per line; up/down keep a desired column", () => {
    const t = new Textarea("longer line\nab\nanother long line");
    t.key(key("end"));
    expect(t.col).toBe(11);
    t.key(key("down"));
    expect([t.row, t.col]).toEqual([1, 2]); // clamped to the short line
    t.key(key("down"));
    expect([t.row, t.col]).toEqual([2, 11]); // desired column restored
    t.key(key("home"));
    expect(t.col).toBe(0);
  });

  test("submit and cancel are surfaced as events, not swallowed", () => {
    const t = new Textarea("body");
    expect(t.key(key("d", { ctrl: true }))).toBe("submit");
    expect(t.key(key("esc"))).toBe("cancel");
    expect(t.key(key("f5"))).toBe("ignored");
    expect(t.value).toBe("body"); // a named key is never typed into the buffer
  });

  test("soft wrap scrolls to the caret and reports where it is", () => {
    const s = surface(12, 3);
    const t = new Textarea("one two three four five six seven");
    t.key(key("end"));
    for (let i = 0; i < 4; i++) t.key(key("down"));
    const pos = t.render(s, { x: 0, y: 0, w: 12, h: 3 }, c, true);
    expect(pos).not.toBeNull();
    expect(pos!.y).toBeGreaterThanOrEqual(0);
    expect(pos!.y).toBeLessThan(3);
    for (const line of s.toText().split("\n"))
      expect(line.length).toBeLessThanOrEqual(12);
  });
});

describe("markdown", () => {
  const md = [
    "# Title",
    "",
    "A **bold** and *italic* paragraph with `code` and a [link](https://x.dev).",
    "",
    "> quoted",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "",
    "```ts",
    "const x: number = 1; // note",
    "```",
    "",
    "---",
  ].join("\n");

  test("blocks render to the shapes the design system promises", () => {
    const lines = renderMarkdown(md, 40, c).map((l) => lineText(l).trimEnd());
    expect(lines).toEqual([
      "Title",
      "────────────────────────────────────────",
      "",
      "A bold and italic paragraph with code",
      "and a link https://x.dev.",
      "",
      "│ quoted",
      "",
      "▸ one",
      "▸ two",
      "",
      "1. first",
      "",
      " const x: number = 1; // note",
      "",
      "────────────────────────────────────────",
    ]);
  });

  test("a link is accent plus underline with the URL dimmed", () => {
    const line = renderMarkdown("[docs](https://x.dev)", 40, c)[0]!;
    expect(line[0]!.style.fg).toBe(c.accent);
    expect(line[0]!.style.attr & UNDERLINE).toBe(UNDERLINE);
    expect(line[1]!.style.fg).toBe(c.faint);
  });

  test("a fence suppresses inline parsing and takes syntax colours", () => {
    const lines = renderMarkdown("```ts\nconst **x** = 1;\n```", 40, c);
    expect(lineText(lines[0]!).trimEnd()).toBe(" const **x** = 1;");
    expect(lines[0]![1]!.style.fg).toBe(c.tok.keyword);
    expect(lines[0]![0]!.style.bg).toBe(c.muted);
  });

  test("wrapping measures plain text, never escape bytes", () => {
    const lines = renderMarkdown("**aaa** bbb ccc ddd", 8, c);
    for (const line of lines)
      expect(lineText(line).length).toBeLessThanOrEqual(8);
  });
});

describe("diff", () => {
  const raw = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,3 @@ function f()
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
`;

  test("gutters, a decorated location and add/delete tints", () => {
    const file = parseUnifiedDiff(raw).files[0]!;
    const lines = renderFileDiff(file, 46, c).map((l) => lineText(l).trimEnd());
    expect(lines).toEqual([
      "▾ a.ts                                  +1 -1",
      " a.ts:1  function f()",
      "   1    1 const a = 1;",
      "   2     -const b = 2;",
      "        2+const b = 3;",
      "   3    3 const c = 4;",
    ]);
  });

  test("syntax owns the foreground, the diff owns the background", () => {
    const file = parseUnifiedDiff(raw).files[0]!;
    const lines = renderFileDiff(file, 46, c);
    const added = lines[4]!;
    // Every span on an added line sits on the add background…
    for (const span of added.slice(2))
      expect(span.style.bg === c.addBg || span.style.bg === c.wdAdd).toBe(true);
    // …and the keyword still carries its syntax colour.
    expect(added.some((s) => s.style.fg === c.tok.keyword)).toBe(true);
  });

  test("an intra-line change gets the stronger word-diff tint", () => {
    const file = parseUnifiedDiff(raw).files[0]!;
    const lines = renderFileDiff(file, 46, c);
    const del = lines[3]!;
    const add = lines[4]!;
    // Only the changed token is tinted — "2" on the old side, "3" on the new.
    expect(
      del.filter((s) => s.style.bg === c.wdDel).map((s) => s.text),
    ).toEqual(["2"]);
    expect(
      add.filter((s) => s.style.bg === c.wdAdd).map((s) => s.text),
    ).toEqual(["3"]);
  });

  test("tabs are expanded so the gutter stays aligned", () => {
    const tabbed = raw.replace("+const b = 3;", "+\tconst b = 3;");
    const file = parseUnifiedDiff(tabbed).files[0]!;
    const line = lineText(renderFileDiff(file, 46, c)[4]!);
    expect(line.startsWith("        2+    const b = 3;")).toBe(true);
  });
});

describe("the gallery renders at every breakpoint", () => {
  test("80x24, 120x40 and 60x20 stay inside their frames", () => {
    for (const [cols, rows] of [
      [80, 24],
      [120, 40],
      [60, 20],
    ] as [number, number][]) {
      const text = galleryFrame(cols, rows);
      const lines = text.split("\n");
      expect(lines.length).toBe(rows);
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols);
      expect(text).toContain("forge");
      expect(text).toContain("Components");
    }
  });

  test("two panes at ≥100 columns, one below", () => {
    expect(galleryFrame(120, 30)).toContain("button");
    expect(galleryFrame(80, 24)).not.toContain("badge · label");
  });

  test("a terminal too small says so rather than drawing garbage", () => {
    expect(galleryFrame(18, 8)).toContain("Resize");
  });

  test("every section draws without throwing at 100x28", () => {
    for (let i = 0; i < 6; i++) {
      const keys = [...Array<string>(i).fill("j"), "enter"];
      const text = galleryFrame(100, 28, keys);
      expect(text).not.toContain("render error");
    }
  });
});
