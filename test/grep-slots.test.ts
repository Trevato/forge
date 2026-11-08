/** Code greps hold a slot until git settles, not until the search answers (#7123). */
import { expect, test } from "bun:test";
import { createGrepSlots } from "../src/search/grep_slots.ts";
import { grepRepos } from "../src/core/search.ts";
import type { Repo } from "../src/core/repos.ts";

const never = () => {
  let settle!: () => void;
  let began!: () => void;
  const started = new Promise<void>((r) => (began = r));
  const grep = () =>
    new Promise<null>((done) => {
      settle = () => done(null);
      began();
    });
  return { grep, started, settle: () => settle() };
};
const repo = (i: number) =>
  ({ id: `r${i}`, ownerName: "u", name: `r${i}`, defaultBranch: "main", archivedAt: null }) as Repo;

test("strangers hold 4, a member 2, and settling frees the slot", async () => {
  const slots = createGrepSlots();
  const hung = Array.from({ length: 4 }, never);
  const strangers = hung.map((h) => slots.run(undefined, h.grep));
  expect(slots.held()).toEqual({ total: 4, strangers: 4 });

  // A fifth stranger is refused while a member's grep still runs.
  const member = never();
  const mine = slots.run("m1", member.grep);
  expect(await slots.run(undefined, async () => 1)).toEqual({ ran: false });
  expect(await slots.run("m1", async () => 1).then((r) => r.ran)).toBe(true);

  // The member's second runs; the third is refused.
  const second = never();
  const again = slots.run("m1", second.grep);
  expect(await slots.run("m1", async () => 1)).toEqual({ ran: false });
  // Another member is not charged for m1's slots.
  expect((await slots.run("m2", async () => 1)).ran).toBe(true);

  // Settling frees exactly that slot.
  second.settle();
  await again;
  expect((await slots.run("m1", async () => 1)).ran).toBe(true);
  hung[0]!.settle();
  await strangers[0];
  expect((await slots.run(undefined, async () => 1)).ran).toBe(true);

  for (const h of hung) h.settle();
  member.settle();
  await Promise.all([...strangers, mine]);
  expect(slots.held()).toEqual({ total: 0, strangers: 0 });
});

test("the forge-wide total bounds members too, and a throwing grep frees its slot", async () => {
  const slots = createGrepSlots({ total: 3, strangers: 1, perMember: 2 });
  const a = never();
  const b = never();
  const pa = slots.run("a", a.grep);
  const pb = slots.run("b", b.grep);
  expect(await slots.run("c", async () => 1)).toEqual({ ran: false });
  a.settle();
  await pa;
  await expect(slots.run("c", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
  expect(slots.held().total).toBe(1);
  b.settle();
  await pb;
});

test("a search refused a slot skips that repo and says so", async () => {
  const slots = createGrepSlots({ total: 8, strangers: 4, perMember: 1 });
  const hung = never();
  // Settle only once the second repo has been refused, so the order is fixed.
  let refused!: () => void;
  const wasRefused = new Promise<void>((r) => (refused = r));
  const watched: typeof slots = {
    held: slots.held,
    run: async (id, grep) => {
      const got = await slots.run(id, grep);
      if (!got.ran) refused();
      return got;
    },
  };
  const search = grepRepos("/nowhere", [0, 1].map(repo), "q", 10, Infinity, {
    memberId: "m1",
    slots: watched,
    grep: hung.grep as never,
  });
  await Promise.all([hung.started, wasRefused]);
  hung.settle();
  const out = await search;
  expect(out.skipped).toBe(true);
  expect(out.hits).toEqual([]);
  expect(slots.held().total).toBe(0);
});

test("members together never take the strangers' share", async () => {
  const slots = createGrepSlots();
  const hung = ["a", "a", "b", "b"].map((id) => ({ id, ...never() }));
  const held = hung.map((h) => slots.run(h.id, h.grep));
  // Four member slots are all members may hold of 8, with 4 for strangers.
  expect(await slots.run("c", async () => 1)).toEqual({ ran: false });
  const strangers = Array.from({ length: 4 }, never);
  const theirs = strangers.map((h) => slots.run(undefined, h.grep));
  expect(slots.held()).toEqual({ total: 8, strangers: 4 });
  for (const h of [...hung, ...strangers]) h.settle();
  await Promise.all([...held, ...theirs]);
  expect((await slots.run("c", async () => 1)).ran).toBe(true);
});
