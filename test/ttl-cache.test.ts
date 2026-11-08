import { expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import { forget, remembered } from "../src/core/ttl_cache.ts";

test("a read asked again within the memory is not made again, until forgotten", async () => {
  const app = {} as App;
  let made = 0;
  const read = () => remembered(app, "k", async () => ++made);
  expect(await Promise.all([read(), read(), read()])).toEqual([1, 1, 1]);
  expect(await read()).toBe(1);
  forget(app);
  expect(await read()).toBe(2);
});

test("a failed read is not kept", async () => {
  const app = {} as App;
  let made = 0;
  const read = () => remembered(app, "k", async () => { if (++made === 1) throw new Error("no"); return made; });
  await expect(read()).rejects.toThrow("no");
  expect(await read()).toBe(2);
});

test("memories are per app and per key", async () => {
  const a = {} as App, b = {} as App;
  expect(await remembered(a, "k", async () => "a")).toBe("a");
  expect(await remembered(b, "k", async () => "b")).toBe("b");
  expect(await remembered(a, "j", async () => "j")).toBe("j");
});
