import { expect, test } from "bun:test";
import { waveLine } from "../src/web/pages/waves.ts";
import { waveRows } from "../src/tui/screens/waves.ts";
import type { Wave } from "../src/story/wave.ts";

const wave = (version: string, date: string, headline: string): Wave => ({
  version,
  date,
  headline,
  highlights: [],
  pulls: [],
});

test("waveLine puts the date right after the version", () => {
  expect(waveLine(wave("0.7.12", "2026-10-20", "Headline"), 4)).toBe(
    "0.7.12 · 2026-10-20 · Headline · 4 pulls",
  );
  expect(waveLine(wave("0.7.12", "2026-10-20", "Headline"), 1)).toContain("1 pull");
});

test("the terminal's row says the same line", () => {
  const rows = waveRows([{ ok: true, file: "0.7.12.md", wave: wave("0.7.12", "2026-10-20", "Headline") }]);
  expect(rows[0]!.title).toBe("0.7.12 · 2026-10-20 · Headline");
});
