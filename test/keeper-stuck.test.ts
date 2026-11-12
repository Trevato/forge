/** The flow keeper reads stuck pulls (#7556): approved, quiet 30 minutes, not landable; and answers the stuck alarm. */
import { expect, test } from "bun:test";
import { ago, runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");

test("an approved pull with a red check and no event for 40 minutes is stuck, and the alarm gets an answer", async () => {
  const s = await seed();
  const pull = s.pull({ number: 1, author: s.builders.ada!, assignee: s.builders.ada!, createdAt: ago(now, 40) });
  s.run({ pull, kind: "check", state: "failed", head: "head1", at: ago(now, 40) });
  const out = await runKeeper(s, now);
  expect(out.findings.map((f) => f.summary)).toContain("owner/app#1 is approved and stuck: red, quiet for 40 min");
  expect(out.actions.some((a) => a.startsWith("alarm stuck: 1 stuck pull read"))).toBe(true);
  expect(out.findings.every((f) => f.probe !== undefined)).toBe(true);
});

test("conflicted and unchecked say so", async () => {
  const s = await seed();
  s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 90) });
  s.pull({ number: 2, author: s.builders.ada!, createdAt: ago(now, 90) });
  const out = await runKeeper(s, now, { conflicted: () => new Set(["owner/app#1"]) });
  const says = out.findings.map((f) => f.summary);
  expect(says).toContain("owner/app#1 is approved and stuck: conflicted, quiet for 90 min");
  expect(says).toContain("owner/app#2 is approved and stuck: unchecked, quiet for 90 min");
});

test("green and approved on its head is queue wait; a recent event, a hold or no approval is not stuck", async () => {
  const s = await seed();
  const green = s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 90) });
  s.run({ pull: green, kind: "check", state: "ok", head: "head1", at: ago(now, 80) });
  s.pull({ number: 2, author: s.builders.ada!, createdAt: ago(now, 10) });
  const held = s.pull({ number: 3, author: s.builders.ada!, createdAt: ago(now, 90) });
  s.hold(held, s.person, ago(now, 80));
  s.pull({ number: 4, author: s.builders.ada!, createdAt: ago(now, 90), approved: false });
  const out = await runKeeper(s, now);
  expect(out.findings.filter((f) => f.summary.includes("approved and stuck"))).toEqual([]);
});
