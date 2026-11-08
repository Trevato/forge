/** The clog-cleared note: full, without dollars, minutes and hours, never negative. */
import { expect, test } from "bun:test";
import { clogNote, duration } from "../src/flow/clog_note.ts";

const M = 60_000;
const base = { reasons: ["red main", "no reviewer"], startedAt: 0, detectedAt: 10 * M, clearedAt: 70 * M };

test("a full note names cause, both times and the dollars", () => {
  const note = clogNote({ ...base, strandedUsd: 1234.5 });
  expect(note).toBe(
    "Clog cleared. Cause: red main; no reviewer.\n\n- Time to detect: 10 min\n- Time to clear: 60 min\n- Stranded at peak: $1,234.5\n",
  );
});

test("no dollars leaves the line out", () => {
  expect(clogNote(base)).not.toContain("Stranded");
  expect(clogNote({ ...base, strandedUsd: 0 })).not.toContain("Stranded");
});

test("minutes up to 90, hours past it", () => {
  expect(duration(90 * M)).toBe("90 min");
  expect(duration(91 * M)).toBe("1.5 h");
  expect(duration(150 * M)).toBe("2.5 h");
});

test("a negative span reads as zero", () => {
  expect(duration(-5 * M)).toBe("0 min");
  expect(clogNote({ ...base, detectedAt: -M })).toContain("Time to detect: 0 min");
});

test("no reasons still reads", () => {
  expect(clogNote({ ...base, reasons: [] })).toContain("Cause: not recorded.");
});

test("a detection that was not measured prints no time to detect", () => {
  const note = clogNote({ ...base, detectedAt: base.startedAt });
  expect(note).not.toContain("Time to detect");
  expect(note).toContain("- Time to clear: 70 min");
});
