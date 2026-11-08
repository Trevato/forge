import { expect, test } from "bun:test";
import { codeRows } from "../src/web/code_rows.ts";
import { rowsOffThread } from "../src/web/code_rows_pool.ts";

const src = new TextEncoder().encode("const a = 1;\nif (a < 2) { return \"<b>\"; }\nlast\n");

test("a worker builds the same rows the main thread would", async () => {
  const made = await rowsOffThread(src, "x.ts", 1_500);
  const text = new TextDecoder().decode(src).replace(/\n$/, "");
  expect(made).toEqual(codeRows(text, "x.ts", 1_500));
  expect(made!.shown).toBe(3);
  expect(made!.rows).toContain('id="L3"');
  expect(made!.rows).not.toContain("<b>");
});

test("only the first lines are drawn but the whole file is counted", async () => {
  const body = new TextEncoder().encode(Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n"));
  const made = await rowsOffThread(body, "a.txt", 10);
  expect(made).toMatchObject({ total: 50, shown: 10 });
});

test("a worker encodes a page to the bytes the main thread would", async () => {
  const { compressBytes } = await import("../src/http/compress.ts");
  const { encodeOffThread } = await import("../src/web/code_rows_pool.ts");
  const page = new TextEncoder().encode("<p>hello</p>".repeat(500));
  const made = await encodeOffThread(page, "gzip");
  expect(Buffer.from(made!).equals(Buffer.from(compressBytes(page, "gzip")))).toBe(true);
});

test("a saturated pool answers undefined at once, and keepPage still stores a correct page", async () => {
  const { keepPage, keptPage } = await import("../src/web/pages/kept_page.ts");
  const { encodeRecent } = await import("../src/http/compress.ts");
  const big = new TextEncoder().encode("x\n".repeat(20_000));
  const jobs = Array.from({ length: 64 }, () => rowsOffThread(big, "a.txt", 1_500));
  expect(await rowsOffThread(src, "x.ts", 10)).toBeUndefined(); // the 65th: MAX_PENDING
  const html = new TextEncoder().encode("<p>kept</p>".repeat(300));
  const key = "gzip\0saturated-test";
  const served = await keepPage(key, new Response(html, { headers: { "content-type": "text/html" } }), true);
  const expected = encodeRecent(html, "gzip");
  expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(expected))).toBe(true);
  const again = keptPage(key);
  expect(Buffer.from(await again!.arrayBuffer()).equals(Buffer.from(expected))).toBe(true);
  await Promise.all(jobs);
});

test("a worker that errors answers its in-flight jobs undefined at once, not after the timeout", async () => {
  const { workersForTest } = await import("../src/web/code_rows_pool.ts");
  const big = new TextEncoder().encode("x\n".repeat(200_000));
  const pending = Array.from({ length: 4 }, () => rowsOffThread(big, "a.txt", 1_500));
  const began = performance.now();
  for (const w of [...workersForTest()]) w.onerror?.(new ErrorEvent("error"));
  expect(await Promise.all(pending)).toEqual([undefined, undefined, undefined, undefined]);
  expect(performance.now() - began).toBeLessThan(1_000);
  // The pool starts fresh workers for the next job.
  expect(await rowsOffThread(src, "x.ts", 1_500)).toBeDefined();
});
