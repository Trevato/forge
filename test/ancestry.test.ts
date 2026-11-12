/** The ancestry cache answers from memory, misses on a new commit, evicts oldest first and refuses oversize answers (#6290). */
import { expect, test } from "bun:test";
import { AncestryCache } from "../src/web/studio/ancestry.ts";

const fake = (sizes: Record<string, number>) => {
  const asked: string[] = [];
  const read = async (dir: string, oid: string) => {
    asked.push(`${dir}:${oid}`);
    const n = sizes[oid];
    return n === undefined ? undefined : new Set(Array.from({ length: n }, (_, i) => `${oid}${i}`));
  };
  return { asked, read };
};

test("a second ask for the same commit does not reach git, a new commit does", async () => {
  const { asked, read } = fake({ a: 2, b: 3 });
  const cache = new AncestryCache(100, read);
  expect((await cache.of("/r", "a"))?.size).toBe(2);
  expect((await cache.of("/r", "a"))?.size).toBe(2);
  expect(cache.reads).toBe(1);
  await cache.of("/r", "b"); // a deploy landed: a different commit
  await cache.of("/other", "a"); // the same commit in another repository
  expect(asked).toEqual(["/r:a", "/r:b", "/other:a"]);
});

test("an answer git could not give is asked again", async () => {
  const { asked, read } = fake({});
  const cache = new AncestryCache(100, read);
  await cache.of("/r", "gone");
  await cache.of("/r", "gone");
  expect(asked.length).toBe(2);
});

test("the oldest answer goes first, and a read one is young again", async () => {
  const { read } = fake({ a: 8, b: 8, c: 8, d: 8, e: 8 });
  const cache = new AncestryCache(32, read);
  for (const oid of ["a", "b", "c", "d"]) await cache.of("/r", oid);
  await cache.of("/r", "a"); // a is the freshest now
  await cache.of("/r", "e"); // 40 > 32: b, the oldest, goes
  expect(["a", "b", "c", "d", "e"].map((o) => cache.has("/r", o))).toEqual([true, false, true, true, true]);
});

test("an answer over a quarter of the bound is returned but not kept", async () => {
  const { asked, read } = fake({ big: 5, ok: 4 });
  const cache = new AncestryCache(16, read);
  expect((await cache.of("/r", "big"))?.size).toBe(5);
  expect(cache.has("/r", "big")).toBe(false);
  await cache.of("/r", "big");
  expect(asked.length).toBe(2);
  await cache.of("/r", "ok");
  expect(cache.has("/r", "ok")).toBe(true);
});

test("a new commit after a kept one grows from it; one that does not reach it reads the whole history (#8388)", async () => {
  const { asked, read } = fake({ a: 3, x: 2 });
  const since = async (_dir: string, oid: string, base: string) =>
    oid === "x"
      ? { added: new Set(["x"]), reaches: false }
      : {
          added: new Set([oid, `${oid}-1`]),
          reaches: base === "a" || base === "b",
        };
  const cache = new AncestryCache(100, read, since);
  await cache.of("/r", "a");
  const b = await cache.of("/r", "b"); // a deploy on top of a
  expect([...(b ?? [])].sort()).toEqual(["a0", "a1", "a2", "b", "b-1"]);
  expect(cache.grown).toBe(1);
  await cache.of("/r", "x"); // force-pushed: b is not its ancestor
  expect(asked).toEqual(["/r:a", "/r:x"]);
  expect(cache.reads).toBe(4); // a, b since a, x since b, then x whole
});
