/** Wrongly held pulls (#7556): a stale or answered crew hold is lifted; a person's never. */
import { expect, test } from "bun:test";
import { getHold } from "../src/core/holds.ts";
import { ago, runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");

test("a person's hold stays however old; a crew hold older than 6 hours is lifted", async () => {
  const s = await seed();
  const mine = s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 900) });
  s.hold(mine, s.person, ago(now, 800));
  const stale = s.pull({ number: 2, author: s.builders.ada!, createdAt: ago(now, 900) });
  s.hold(stale, s.builders.bo!, ago(now, 400));
  const fresh = s.pull({ number: 3, author: s.builders.ada!, createdAt: ago(now, 900) });
  s.hold(fresh, s.builders.bo!, ago(now, 60));
  const out = await runKeeper(s, now);
  expect(getHold(s.db, mine)).toBeDefined();
  expect(getHold(s.db, stale)).toBeUndefined();
  expect(getHold(s.db, fresh)).toBeDefined();
  expect(out.actions.filter((a) => a.includes("lifted bo"))).toEqual(["owner/app#2: lifted bo's hold (the hold was older than 6 hours)"]);
});

test("a crew hold with a check green on its head after the hold is lifted", async () => {
  const s = await seed();
  const pull = s.pull({ number: 1, author: s.builders.ada!, createdAt: ago(now, 120) });
  s.hold(pull, s.builders.bo!, ago(now, 60));
  s.run({ pull, kind: "check", state: "ok", head: "head1", at: ago(now, 20) });
  const before = s.pull({ number: 2, author: s.builders.ada!, createdAt: ago(now, 120) });
  s.hold(before, s.builders.bo!, ago(now, 10));
  s.run({ pull: before, kind: "check", state: "ok", head: "head2", at: ago(now, 50) }); // green came before the hold
  const out = await runKeeper(s, now);
  expect(getHold(s.db, pull)).toBeUndefined();
  expect(getHold(s.db, before)).toBeDefined();
  expect(out.actions.join("\n")).toContain("a check went green on its head after the hold");
});
