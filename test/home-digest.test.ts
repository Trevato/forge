import { expect, test } from "bun:test";
import { digest, type DigestEvent } from "../src/feed/digest.ts";

const now = Date.parse("2026-10-26T12:00:00Z");
const H = 3600 * 1000;
const ev = (repo: string, kind: DigestEvent["kind"], ago: number, weight: number, href = `/${repo}/${kind}/${ago}`): DigestEvent => ({
  repo, kind, at: now - ago, href, weight,
});

test("nothing in the window gives []", () => {
  expect(digest([], now)).toEqual([]);
  expect(digest([ev("a/x", "landed", 25 * H, 5)], now)).toEqual([]);
});

test("three repositories: biggest first, says counts, heaviest link", () => {
  const out = digest(
    [
      ev("alice/forge", "landed", H, 3, "/l1"),
      ev("alice/forge", "landed", 2 * H, 5, "/l2"),
      ev("alice/forge", "released", 3 * H, 1, "/r1"),
      ev("bob/app", "failed", H, 2, "/f1"),
      ev("carol/lib", "decided", H, 20, "/d1"),
    ],
    now,
  );
  expect(out.map((l) => l.repo)).toEqual(["carol/lib", "alice/forge", "bob/app"]);
  expect(out[1]).toEqual({ repo: "alice/forge", says: "alice/forge: 2 landed, 1 released", href: "/l2" });
  expect(out[0]!.href).toBe("/d1");
});

test("capped at three lines", () => {
  const events = ["a", "b", "c", "d", "e"].map((r, i) => ev(`o/${r}`, "landed", H, i + 1));
  expect(digest(events, now).map((l) => l.repo)).toEqual(["o/e", "o/d", "o/c"]);
});

test("window edge: exactly 24 h is in, a millisecond older is out, the future is out", () => {
  expect(digest([ev("o/a", "landed", 24 * H, 1)], now)).toHaveLength(1);
  expect(digest([ev("o/a", "landed", 24 * H + 1, 1)], now)).toEqual([]);
  expect(digest([ev("o/a", "landed", -1, 1)], now)).toEqual([]);
});

test("bad weights count as 0 and never choose the link", () => {
  for (const bad of [Number.NaN, -3, Number.POSITIVE_INFINITY]) {
    const out = digest([ev("o/a", "failed", 2 * H, bad, "/bad"), ev("o/a", "landed", H, 1, "/real")], now);
    expect(out).toEqual([{ repo: "o/a", says: "o/a: 1 landed, 1 failed", href: "/real" }]);
  }
});

test("200 repositories digest to three lines", () => {
  const events: DigestEvent[] = [];
  for (let r = 0; r < 200; r++) for (let k = 0; k < 5; k++) events.push(ev(`o/r${r}`, "landed", k * H, r + k));
  expect(digest(events, now)).toHaveLength(3);
});
