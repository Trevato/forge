import { expect, test } from "bun:test";
import { waveLine } from "../src/story/waves.ts";
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
  expect(waveLine(wave("0.7.12", "2026-10-20", "Headline"), { pulls: 4, apps: 2 })).toBe(
    "0.7.12 · 2026-10-20 · Headline · 4 changes in 2 apps",
  );
  expect(waveLine(wave("0.7.12", "2026-10-20", "Headline"), { pulls: 1, apps: 1 })).toContain("1 change in 1 app");
});

test("the terminal's row says the same line, size and all", () => {
  const entry = { ok: true as const, file: "0.7.12.md", wave: wave("0.7.12", "2026-10-20", "Headline") };
  expect(waveRows([entry], () => ({ pulls: 7, apps: 3 }))[0]!.title).toBe("0.7.12 · 2026-10-20 · Headline · 7 changes in 3 apps");
  expect(waveRows([entry], () => ({ pulls: 1, apps: 1 }))[0]!.title).toBe("0.7.12 · 2026-10-20 · Headline · 1 change in 1 app");
});
