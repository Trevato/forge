import { describe, expect, test } from "bun:test";
import { Screen } from "../src/tui/term/screen.ts";
import { BOLD } from "../src/tui/term/style.ts";
import { ListState } from "../src/tui/screens/common.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { cell, drawRows, type Column } from "../src/tui/local/rows.ts";

const c = theme("dark").c;

function draw(
  w: number,
  columns: readonly Column[],
  rows: string[][],
  index = 0,
): Screen {
  const s = new Screen(w, rows.length);
  const list = new ListState();
  list.index = index;
  drawRows(
    s,
    { x: 0, y: 0, w, h: rows.length },
    c,
    list,
    columns,
    rows.map((r) => r.map((t) => cell(t))),
  );
  return s;
}

const line = (s: Screen, y: number): string =>
  Array.from({ length: s.cols }, (_, x) => s.textAt(x, y)).join("");

describe("drawRows", () => {
  test("columns start at the same x, two spaces apart, none before the first", () => {
    const s = draw(40, [{}, {}, {}], [
      ["alpha", "one", "x"],
      ["be", "three", "yy"],
      ["gamma-ray", "t", "zzz"],
    ]);
    // gutter of two, then widths 9, 5, 3 with two spaces between
    const starts = [2, 2 + 9 + 2, 2 + 9 + 2 + 5 + 2];
    const expected = [
      ["alpha", "one", "x"],
      ["be", "three", "yy"],
      ["gamma-ray", "t", "zzz"],
    ];
    expected.forEach((fields, y) => {
      const text = line(s, y);
      fields.forEach((f, j) => {
        expect(text.slice(starts[j]!, starts[j]! + f.length)).toBe(f);
      });
      expect(text.slice(0, 2)).toBe(y === 0 ? "▸ " : "  ");
      // exactly two spaces between the columns, even after the widest cell
      expect(text.slice(2 + 9, 2 + 9 + 2)).toBe("  ");
    });
  });

  test("a narrow pane drops columns in `drop` order, lowest first", () => {
    const columns: Column[] = [{}, { drop: 2 }, { drop: 1 }];
    const rows = [["name-here", "second", "third!"]];
    // natural: 9 + 2 + 6 + 2 + 6 = 25 > 22; losing rank 1 leaves 17 <= 22
    const some = line(draw(25, columns, rows), 0);
    expect(some).toContain("name-here  second");
    expect(some).not.toContain("third!");
    // at 15 the pane (12 after gutter and scrollbar) loses rank 2 as well
    const few = line(draw(15, columns, rows), 0);
    expect(few).toContain("name-here");
    expect(few).not.toContain("second");
    expect(few).not.toContain("third!");
    // wide enough and nothing is dropped
    expect(line(draw(40, columns, rows), 0)).toContain("third!");
  });

  test("a column never draws narrower than its min", () => {
    const columns: Column[] = [{ min: 4 }, { min: 5 }];
    const rows = [["abcdefghij", "klmnopqr"]];
    // 10 leaves 7 cells for minimums that need 4+2+5: they hold, and the
    // second column still starts at 2+4+2 (clipped by the pane's edge)
    const s = draw(10, columns, rows);
    const text = line(s, 0);
    expect(text.slice(6, 8)).toBe("  ");
    expect(text[8]).toBe("k");
    // the first column shows exactly 4 cells: three letters and an ellipsis
    expect(text.slice(2, 5)).toBe("abc");
    expect(text[5]).toBe("…");
  });

  test("the selected row's emphasis column is bold, others are not", () => {
    const columns: Column[] = [{}, { emphasis: true }];
    const rows = [
      ["aa", "bb"],
      ["cc", "dd"],
    ];
    const s = draw(20, columns, rows, 0);
    const bold = (x: number, y: number): boolean =>
      (s.styleAt(x, y).attr & BOLD) !== 0;
    expect(bold(2, 0)).toBe(false); // plain column, selected row
    expect(bold(6, 0)).toBe(true); // emphasis column, selected row
    expect(bold(2, 1)).toBe(false);
    expect(bold(6, 1)).toBe(false); // emphasis column, other row
  });
});
