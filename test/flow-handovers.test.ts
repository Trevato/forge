import { expect, test } from "bun:test";
import { handovers, handoversSays } from "../src/flow/handovers.ts";

const now = Date.parse("2026-10-26T12:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const H = 3600_000;

test("the window edge: exactly 24 h counts, a millisecond more does not", () => {
  const h = handovers(
    [
      { pull: 1, at: ago(24 * H) },
      { pull: 2, at: ago(24 * H + 1) },
      { pull: 3, at: new Date(now + 1).toISOString() },
      { pull: 4, at: "nonsense" },
    ],
    now,
  );
  expect(h).toEqual({ count: 1, newest: [1] });
});

test("names the newest three, newest first, counting all", () => {
  const h = handovers(
    [
      { pull: 10, at: ago(5 * H) },
      { pull: 11, at: ago(1 * H) },
      { pull: 12, at: ago(3 * H) },
      { pull: 13, at: ago(2 * H) },
    ],
    now,
  );
  expect(h).toEqual({ count: 4, newest: [11, 13, 12] });
  expect(handoversSays(h)).toBe(
    "4 pulls handed to a person after three review rounds in the last 24 h, newest #11, #13, #12.",
  );
});

test("a pull handed over twice counts once", () => {
  const h = handovers([{ pull: 7, at: ago(H) }, { pull: 7, at: ago(2 * H) }], now);
  expect(h.count).toBe(1);
  expect(handoversSays(h)).toContain("1 pull handed");
});

test("empty says nothing", () => {
  const h = handovers([], now);
  expect(h).toEqual({ count: 0, newest: [] });
  expect(handoversSays(h)).toBe("");
});
