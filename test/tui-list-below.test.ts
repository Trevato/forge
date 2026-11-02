/** `drawList` rows with lines under them, and the cursor arithmetic for rows taller than one line (#8056). */
import { describe, expect, test } from "bun:test";
import { ListState, drawList, type ListRow } from "../src/tui/screens/common.ts";
import { Screen } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";

describe("ListState.windowRows", () => {
  test("keeps the cursor's whole row on screen", () => {
    const list = new ListState();
    list.index = 2;
    // rows of 3 lines in 7: rows 1 and 2 fit (6 lines), row 0 does not
    expect(list.windowRows(7, [3, 3, 3])).toBe(1);
  });

  test("leaves no empty room at the bottom while rows above could fill it", () => {
    const list = new ListState();
    list.offset = 2;
    list.index = 2;
    expect(list.windowRows(10, [2, 2, 2])).toBe(0);
  });
});

describe("drawList with below", () => {
  const draw = (w: number, h: number, rows: ListRow[], index = 0): string[] => {
    const s = new Screen(w, h);
    const state = new ListState();
    state.index = index;
    drawList(s, { x: 0, y: 0, w, h }, theme("dark").c, state, rows);
    return s.toText().split("\n");
  };

  test("draws each row's lines under it, indented and wrapped, not cut", () => {
    const lines = draw(22, 6, [{ title: "one", below: ["alpha beta gamma delta"] }, { title: "two" }]);
    expect(lines[0]).toContain("one");
    expect(lines[1]!.trimEnd()).toBe("    alpha beta gamma");
    expect(lines[2]!.trimEnd()).toBe("    delta");
    expect(lines[3]).toContain("two");
  });

  test("scrolls by whole rows so the selected one shows with its lines", () => {
    const rows = ["a", "b", "c"].map((t) => ({ title: t, below: [`${t} under`] }));
    const lines = draw(20, 4, rows, 2);
    expect(lines[0]).toContain("b");
    expect(lines[2]).toContain("c");
    expect(lines[3]).toContain("c under");
  });
});
