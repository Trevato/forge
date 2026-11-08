/** `scripts/append-growth.ts`: the counting is pure over numstat rows. */

import { expect, test } from "bun:test";
import { appendGrowth, integer, parseArgs, parseNumstat } from "../scripts/append-growth.ts";

const row = (commit: string, added: number, deleted: number, path: string) => ({
  commit,
  added,
  deleted,
  path,
});

test("counts pure-append commits per file, worst first, above the minimum", () => {
  const rows = [
    ...["a", "b", "c"].map((c) => row(c, 1, 0, "reg.ts")),
    ...["a", "b", "c", "d"].map((c) => row(c, 2, 0, "list.ts")),
    row("a", 1, 0, "once.ts"),
  ];
  expect(appendGrowth(rows, 2)).toEqual([
    { path: "list.ts", count: 4 },
    { path: "reg.ts", count: 3 },
  ]);
  expect(appendGrowth(rows, 3)).toEqual([{ path: "list.ts", count: 4 }]);
});

test("a file with any deleting commit is not append-only", () => {
  const rows = [row("a", 1, 0, "f"), row("b", 1, 0, "f"), row("c", 1, 1, "f")];
  expect(appendGrowth(rows, 0)).toEqual([]);
});

test("parses numstat, skipping binary rows", () => {
  const text = "\0abc\n\n1\t0\ta.ts\n-\t-\timg.png\n3\t2\tb/c.ts\n\0def\n\n4\t0\ta.ts\n";
  expect(parseNumstat(text)).toEqual([
    row("abc", 1, 0, "a.ts"),
    row("abc", 3, 2, "b/c.ts"),
    row("def", 4, 0, "a.ts"),
  ]);
});

test("arguments are validated integers", () => {
  expect(parseArgs([])).toEqual({ days: 7, min: 10 });
  expect(parseArgs(["--days", "3", "--min", "5"])).toEqual({ days: 3, min: 5 });
  expect(parseArgs(["--days", "x; rm -rf /"])).toBeNull();
  expect(parseArgs(["--days", "-1"])).toBeNull();
  expect(parseArgs(["--days"])).toBeNull();
  expect(parseArgs(["--other", "1"])).toBeNull();
  expect(integer("12")).toBe(12);
  expect(integer("1.5")).toBeNull();
});
