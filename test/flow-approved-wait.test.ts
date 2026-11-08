import { expect, test } from "bun:test";
import { approvedWait } from "../src/flow/approved_wait.ts";

const now = new Date("2026-10-26T12:00:00Z");
const ago = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

test("one repository counts its pulls and names the oldest", () => {
  const out = approvedWait([{ repo: "a", number: 1, approvedAt: ago(1) }, { repo: "a", number: 2, approvedAt: ago(5) }], now);
  expect(out).toEqual([{ repo: "a", waiting: 2, oldestHours: 5, oldest: 2 }]);
});

test("several repositories are separate, longest wait first", () => {
  const out = approvedWait(
    [
      { repo: "a", number: 1, approvedAt: ago(2) },
      { repo: "b", number: 7, approvedAt: ago(30) },
      { repo: "c", number: 3, approvedAt: ago(10) },
    ],
    now,
  );
  expect(out.map((r) => r.repo)).toEqual(["b", "c", "a"]);
});

test("nothing approved reads empty", () => {
  expect(approvedWait([], now)).toEqual([]);
});

test("hours round to one decimal", () => {
  const out = approvedWait([{ repo: "a", number: 1, approvedAt: ago(1.26) }], now);
  expect(out[0]!.oldestHours).toBe(1.3);
});

test("an approval in the future reads 0", () => {
  const out = approvedWait([{ repo: "a", number: 1, approvedAt: ago(-3) }], now);
  expect(out[0]!.oldestHours).toBe(0);
});
