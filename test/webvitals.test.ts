import { expect, test } from "bun:test";
import { cls, grade, lcpMs, tbtMs, webvitals, CLS, LCP, TBT } from "../src/release/webvitals.ts";

const shift = (startTime: number, value: number, hadRecentInput = false) => ({ entryType: "layout-shift", startTime, value, hadRecentInput });

test("LCP is the largest candidate's start time, not the latest entry", () => {
  const entries = [
    { entryType: "largest-contentful-paint", startTime: 800, size: 1200 },
    { entryType: "largest-contentful-paint", startTime: 1900.4, size: 50000 },
    { entryType: "largest-contentful-paint", startTime: 2100, size: 900 },
  ];
  expect(lcpMs(entries)).toBe(1900);
  // Without sizes the latest candidate stands.
  expect(lcpMs([{ startTime: 300 }, { startTime: 700 }])).toBe(700);
  expect(lcpMs([])).toBeNull();
});

test("LCP grades at 2.5 s and 4 s, both bounds inclusive", () => {
  expect([2500, 2501, 4000, 4001].map((v) => grade(v, LCP))).toEqual(["good", "needs-improvement", "needs-improvement", "poor"]);
  const v = webvitals({ lcp: [{ startTime: 3200, size: 10 }] }).lcpMs;
  expect(v).toEqual({ value: 3200, grade: "needs-improvement", good: 2500, poor: 4000, unit: "ms", section: LCP.section });
  expect(v.section).toStartWith("https://specification.website/#");
});

test("CLS ignores shifts that had recent input", () => {
  expect(cls([shift(100, 0.05), shift(200, 0.5, true), shift(300, 0.02)])).toBe(0.07);
});

test("CLS is the largest session window; a 1 s gap starts a new window", () => {
  // Window A: 0 ms, 900 ms (gap 900 < 1000) -> 0.04 + 0.04 = 0.08.
  // Window B: 1900 ms (gap exactly 1000, so new), 2500 ms -> 0.03 + 0.03 = 0.06.
  expect(cls([shift(0, 0.04), shift(900, 0.04), shift(1900, 0.03), shift(2500, 0.03)])).toBe(0.08);
  // Order of recording does not matter.
  expect(cls([shift(2500, 0.03), shift(900, 0.04), shift(1900, 0.03), shift(0, 0.04)])).toBe(0.08);
});

test("CLS caps a session window at 5 s", () => {
  // Shifts every 900 ms never leave a 1 s gap; the cap splits them at 5 s:
  // 0..4500 ms (6 shifts, 0.3) and 5400..6300 ms (2 shifts, 0.1).
  const shifts = [0, 900, 1800, 2700, 3600, 4500, 5400, 6300].map((t) => shift(t, 0.05));
  expect(cls(shifts)).toBe(0.3);
  // Uncapped this would have been 0.4.
  expect(cls(shifts.slice(0, 6))).toBe(0.3);
});

test("CLS grades at 0.1 and 0.25, and hides float noise at the bound", () => {
  // 0.07 + 0.03 is 0.09999999999999999 in floats; it reports and grades as 0.1.
  const v = webvitals({ layoutShift: [shift(0, 0.07), shift(10, 0.03)] }).cls;
  expect(v.value).toBe(0.1);
  expect(v.grade).toBe("good");
  expect([0.11, 0.25, 0.26].map((x) => grade(x, CLS))).toEqual(["needs-improvement", "needs-improvement", "poor"]);
  expect(webvitals({}).cls).toMatchObject({ value: 0, grade: "good" });
});

test("TBT sums each long task's time past 50 ms", () => {
  // 120 -> 70, 50 -> 0 (not over), 51 -> 1, 300 -> 250: 321 ms.
  const tasks = [120, 50, 51, 300].map((duration, i) => ({ entryType: "longtask", startTime: i * 1000, duration }));
  expect(tbtMs(tasks)).toBe(321);
  expect(tbtMs([])).toBe(0);
});

test("TBT stands in for INP: good at 200 ms, poor past 600 ms", () => {
  expect([200, 201, 600, 601].map((v) => grade(v, TBT))).toEqual(["good", "needs-improvement", "needs-improvement", "poor"]);
  const v = webvitals({ longtask: [{ duration: 250 }] }).tbtMs;
  expect(v).toMatchObject({ value: 200, grade: "good", unit: "ms" });
  expect(v.section).toContain("interaction-to-next-paint");
});

test("junk at the boundary is dropped, not trusted", () => {
  const junk = [null, 7, "x", { startTime: -5, size: 999 }, { startTime: NaN }, { startTime: "900" }, { startTime: Infinity }];
  const v = webvitals({
    lcp: [...junk, { startTime: 1200, size: 1 }],
    layoutShift: [...junk, { startTime: 0, value: -1 }, { startTime: 0, value: "0.9" }, shift(5, 0.02)],
    longtask: [...junk, { duration: -100 }, { duration: "900" }, { duration: 60 }],
  });
  expect([v.lcpMs.value, v.cls.value, v.tbtMs.value]).toEqual([1200, 0.02, 10]);
  // Not arrays at all.
  const none = webvitals({ lcp: "x", layoutShift: 3, longtask: {} } as never);
  expect([none.lcpMs.value, none.lcpMs.grade, none.cls.value, none.tbtMs.value]).toEqual([null, null, 0, 0]);
});
