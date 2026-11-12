/** A text file over 1,500 lines draws its first 1,500 and links the rest. */
import { describe, expect, test } from "bun:test";
import { blobBody } from "../src/web/pages/repo.ts";
import type { Blob } from "../src/view/source.ts";

const make = (n: number): Blob => {
  const body = new TextEncoder().encode(
    Array.from({ length: n }, (_, i) => `const v${i} = ${i};`).join("\n"),
  );
  return { kind: "text", body, size: body.length };
};
const draw = (n: number, all = false) =>
  String(blobBody("/a/b", "main", "x.ts", make(n), undefined, all).content);
const rows = (h: string) => h.split('<tr id="L').length - 1;

describe("blob window", () => {
  test("5,000 lines: 1,500 rows, a more-lines link, under 500 KB", () => {
    const page = draw(5_000);
    expect(rows(page)).toBe(1_500);
    expect(page).toContain("3,500 more lines");
    expect(page).toContain("/a/b/blob/main/x.ts?all=1");
    expect(page).toContain("/a/b/raw/main/x.ts");
    expect(new TextEncoder().encode(page).length).toBeLessThan(500_000);
  });
  test("?all=1 draws all 5,000", () => {
    const page = draw(5_000, true);
    expect(rows(page)).toBe(5_000);
    expect(page).not.toContain("more lines");
  });
  test("1,500 lines has no link", () => {
    const page = draw(1_500);
    expect(rows(page)).toBe(1_500);
    expect(page).not.toContain("more lines");
    expect(page).not.toContain("?all=1");
  });
});
