import { expect, test } from "bun:test";
import { parseNameStatus, pinEdits } from "../src/kernel/pin_edits.ts";

const pin = "src/core/migration-pins/0001-a.pin";

test("a modified pin is named", () => {
  expect(pinEdits([{ status: "M", path: pin }])).toEqual([pin]);
});

test("a deleted pin is named", () => {
  expect(pinEdits([{ status: "D", path: pin }])).toEqual([pin]);
});

test("a renamed pin is named by its old path; the new one is added", () => {
  const changes = parseNameStatus(`R100\t${pin}\tsrc/core/migration-pins/0002-b.pin`);
  expect(pinEdits(changes)).toEqual([pin]);
});

test("an added pin passes", () => {
  expect(pinEdits([{ status: "A", path: pin }])).toEqual([]);
});

test("paths outside the folder are ignored", () => {
  expect(pinEdits([{ status: "M", path: "src/core/migrations/0001-a.ts" }])).toEqual([]);
});

test("the frozen pins file is history too", () => {
  const f = "src/core/migration-pins.json";
  expect(pinEdits([{ status: "M", path: f }])).toEqual([f]);
});
