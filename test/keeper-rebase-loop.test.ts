/** Conflicted approved pulls go to a builder who can push; two tries with no new head stop (#7556). */
import { expect, test } from "bun:test";
import { ago, runKeeper, seed } from "./helpers/keeper-seed.ts";

const now = new Date("2026-11-11T12:00:00Z");
const conflicted = (...n: number[]) => ({ conflicted: () => new Set(n.map((x) => `owner/app#${x}`)) });
const assignee = (s: Awaited<ReturnType<typeof seed>>, pull: string) =>
  s.db.query<{ a: string | null }, [string]>("SELECT assignee_id AS a FROM issue WHERE id = ?1").get(pull)!.a;
const comments = (s: Awaited<ReturnType<typeof seed>>, pull: string) =>
  s.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM comment WHERE issue_id = ?1 AND body LIKE 'Flow keeper:%'").get(pull)!.n;

test("a conflicted approved pull is re-assigned in one run to the builder who authored it, and not a third time on the same head", async () => {
  const s = await seed();
  const { ada, bo } = s.builders;
  const pull = s.pull({ number: 1, author: ada!, assignee: bo!, createdAt: ago(now, 60) });
  const first = await runKeeper(s, now, conflicted(1));
  expect(first.actions).toContain("re-assigned owner/app#1 to ada");
  expect(assignee(s, pull)).toBe(ada!);

  s.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pull, bo!); // still stuck: someone moved it again
  const second = await runKeeper(s, now, conflicted(1));
  expect(second.actions).toContain("re-assigned owner/app#1 to ada");

  s.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(pull, bo!);
  const third = await runKeeper(s, now, conflicted(1));
  expect(third.actions.some((a) => a.startsWith("re-assigned"))).toBe(false);
  expect(third.actions.some((a) => a.startsWith("stopped re-assigning owner/app#1"))).toBe(true);
  expect(assignee(s, pull)).toBe(bo!);
  expect(comments(s, pull)).toBe(1);

  const fourth = await runKeeper(s, now, conflicted(1));
  expect(fourth.actions.some((a) => a.startsWith("stopped"))).toBe(false);
  expect(comments(s, pull)).toBe(1);

  // A new head is a new chance.
  s.db.query("UPDATE pull SET head_oid = 'newhead' WHERE issue_id = ?1").run(pull);
  s.db.query("UPDATE review SET commit_oid = 'newhead' WHERE issue_id = ?1").run(pull);
  const fifth = await runKeeper(s, now, conflicted(1));
  expect(fifth.actions).toContain("re-assigned owner/app#1 to ada");
});

test("at most six per run; the rest wait for the next", async () => {
  const s = await seed();
  for (let i = 1; i <= 8; i++) s.pull({ number: i, author: s.builders.ada!, assignee: s.builders.bo!, createdAt: ago(now, 60) });
  const out = await runKeeper(s, now, conflicted(1, 2, 3, 4, 5, 6, 7, 8));
  expect(out.actions.filter((a) => a.startsWith("re-assigned")).length).toBe(6);
  expect(out.findings.some((f) => f.summary.startsWith("2 conflicted pulls wait"))).toBe(true);
});

test("a pull a person holds is left alone, and so is one a person is assigned", async () => {
  const s = await seed();
  const held = s.pull({ number: 1, author: s.builders.ada!, assignee: s.builders.bo!, createdAt: ago(now, 60) });
  s.hold(held, s.person, ago(now, 30));
  const handed = s.pull({ number: 2, author: s.builders.ada!, assignee: s.person, createdAt: ago(now, 60) });
  const out = await runKeeper(s, now, conflicted(1, 2));
  expect(out.actions.some((a) => a.startsWith("re-assigned"))).toBe(false);
  expect(assignee(s, handed)).toBe(s.person);
});
