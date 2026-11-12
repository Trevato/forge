import { describe, expect, test } from "bun:test";
import { nextActor, nextAsking, type NextInput } from "../src/flow/next_actor.ts";

const base: NextInput = {
  held: null,
  conflicted: false,
  check: "none",
  changesRequested: 0,
  approvals: 0,
  pushedSince: 0,
};

const cases: [string, Partial<NextInput>, string, string][] = [
  ["held", { held: { by: "sam", why: "wait for legal" }, approvals: 1, check: "ok" }, "person", "sam holds it: wait for legal"],
  ["conflicted", { conflicted: true, approvals: 1, check: "ok" }, "builder", "it conflicts with its base"],
  ["changes asked", { changesRequested: 1, check: "ok" }, "builder", "changes were asked on this head"],
  ["red", { check: "failed", approvals: 1 }, "builder", "its check is red"],
  ["pushed since review", { pushedSince: 1, check: "ok" }, "reviewer", "pushed since the last review"],
  ["no review", { check: "running" }, "reviewer", "no review yet"],
  ["approved and green", { approvals: 1, check: "ok" }, "queue", "approved and green"],
  ["approved, no check", { approvals: 1 }, "queue", "approved, waiting for its check"],
  ["approved, queued", { approvals: 1, check: "queued" }, "queue", "approved, its check is queued"],
  ["approved, cancelled", { approvals: 1, check: "cancelled" }, "queue", "approved, its check was cancelled"],
  ["approved, running", { approvals: 1, check: "running" }, "queue", "approved, its check is running"],
  // The access wall (#7847): a person decides, however approved and green.
  ["walled, approved and green", { approvals: 1, check: "ok", wall: ["anyone signed out could read pack records"] }, "person", "the access wall holds it for a person to decide: anyone signed out could read pack records. Allow it (merge) or send it back"],
  ["walled, sent back", { approvals: 1, check: "ok", changesRequested: 1, wall: ["anyone signed out could read pack records"] }, "builder", "changes were asked on this head"],
  // Reviews off (#11666): nobody waits for a review, but a verdict on the head still counts.
  ["reviews off, green", { check: "ok", reviewOff: true }, "queue", "green, reviews are off: it lands"],
  ["reviews off, no check", { reviewOff: true }, "queue", "no check yet"],
  ["reviews off, running", { check: "running", reviewOff: true }, "queue", "its check is running"],
  ["reviews off, changes asked", { changesRequested: 1, check: "ok", reviewOff: true }, "builder", "changes were asked on this head"],
  ["reviews off, red", { check: "failed", reviewOff: true }, "builder", "its check is red"],
];

describe("nextActor", () => {
  for (const [name, input, who, why] of cases)
    test(name, () => expect(nextActor({ ...base, ...input })).toEqual({ who: who as never, why }));
});

describe("nextAsking (#11666)", () => {
  test("asks whether reviews are off only when the pull would wait on the reviewer", () => {
    let asked = 0;
    const off = () => (asked++, true);
    expect(nextAsking({ ...base, check: "ok", approvals: 1 }, off)).toEqual({ who: "queue", why: "approved and green" });
    expect(nextAsking({ ...base, check: "failed" }, off).who).toBe("builder");
    expect(asked).toBe(0);
    expect(nextAsking({ ...base, check: "ok" }, off)).toEqual({ who: "queue", why: "green, reviews are off: it lands" });
    expect(asked).toBe(1);
  });

  test("with reviews asked for, the reviewer still acts next", () => {
    expect(nextAsking({ ...base, check: "ok" }, () => false)).toEqual({ who: "reviewer", why: "no review yet" });
  });
});
