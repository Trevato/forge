import { expect, test } from "bun:test";
import type { Command } from "../src/tui/app/palette.ts";
import { addEntries, ENTRIES, type PaletteEntry } from "../src/tui/screens/entries.ts";

const base = (...ids: string[]): Command[] => ids.map((id) => ({ id, title: id, run: () => undefined }));
const stub = (id: string, after?: string[]): PaletteEntry => ({
  id, title: id, hint: "", ...(after ? { after } : {}), offered: () => true, run: () => undefined,
});
const place = (commands: Command[], entries: PaletteEntry[]): string[] => {
  const saved = [...ENTRIES];
  (ENTRIES as PaletteEntry[]).splice(0, ENTRIES.length, ...entries);
  try {
    addEntries(commands, {} as never, {} as never);
  } finally {
    (ENTRIES as PaletteEntry[]).splice(0, ENTRIES.length, ...saved);
  }
  return commands.map((c) => c.id);
};

test("entries naming one anchor stack after it in list order", () => {
  expect(place(base("a", "b", "c"), [stub("x", ["a"]), stub("y", ["a"])])).toEqual(["a", "x", "y", "b", "c"]);
});

test("the first id of `after` the session has wins", () => {
  expect(place(base("a", "b", "c"), [stub("x", ["missing", "b", "a"])])).toEqual(["a", "b", "x", "c"]);
});

test("with no anchor present, or none named, an entry goes at the end", () => {
  expect(place(base("a", "b"), [stub("x", ["missing"]), stub("y")])).toEqual(["a", "b", "x", "y"]);
});

test("an entry the session is not offered is left out", () => {
  const hidden = { ...stub("x", ["a"]), offered: () => false };
  expect(place(base("a", "b"), [hidden])).toEqual(["a", "b"]);
});
