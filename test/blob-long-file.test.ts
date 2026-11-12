/** A long file's page draws its first 1,500 lines and links the rest. */
import { describe, expect, test } from "bun:test";
import { blobBody } from "../src/web/pages/repo.ts";
import { highlightPrefix } from "../src/web/code.ts";
import { shellJs, codeJs } from "../src/web/client.ts";
import type { Blob } from "../src/view/source.ts";

const source = Array.from(
  { length: 7_000 },
  (_, i) => `  const v${i} = compute(${i}); // line ${i}`,
).join("\n");
const body = new TextEncoder().encode(source);
const blob: Blob = { kind: "text", body, size: body.length };
const draw = (all = false) =>
  blobBody("/alice/app", "main", "src/big.ts", blob, undefined, all);
const rows = (h: string) => h.split('<tr id="L').length - 1;

describe("long file page", () => {
  test("default draws 1,500 of 7,000 lines, small and fast", () => {
    const page = String(draw().content);
    expect(rows(page)).toBe(1_500);
    expect(page).toContain("5,500 more lines");
    expect(page).toContain("/alice/app/blob/main/src/big.ts?all=1");
    expect(page).toContain("/alice/app/raw/main/src/big.ts");
    // Worst case: every line is dense with token spans (~546 KB, ~25 KB
    // gzipped). Ordinary files weigh far less (hardening.test.ts holds 400 KB).
    expect(new TextEncoder().encode(page).length).toBeLessThan(600_000);
    expect(page).toContain('id="code-cut"');
  });

  test("?all=1 draws every line", () => {
    const page = String(draw(true).content);
    expect(rows(page)).toBe(7_000);
    expect(page).not.toContain("Show all lines");
  });

  test("?all=1 past the 10,000-line ceiling says what is left and points to raw", () => {
    const huge = new TextEncoder().encode("x\n".repeat(12_000));
    const page = String(
      blobBody("/alice/app", "main", "big.txt", { kind: "text", body: huge, size: huge.length }, undefined, true)
        .content,
    );
    expect(rows(page)).toBe(10_000);
    expect(page).toContain("2,000 more lines");
    expect(page).toContain("The rest is in the raw file.");
    expect(page).not.toContain("Show all lines");
  });

  test("a repeat view returns the cached highlight", () => {
    expect(highlightPrefix(source, "src/big.ts", 1_500)).toBe(
      highlightPrefix(source, "src/big.ts", 1_500),
    );
  });

  test("the prefix highlights like the whole file's first lines", () => {
    const whole = highlightPrefix(source, "src/big.ts", 7_000);
    const part = highlightPrefix(source, "src/big.ts", 1_500);
    expect(part.length).toBe(1_500);
    expect(String(part[1_499])).toBe(String(whole[1_499]));
  });

  test("an anchor past the cut is sent to the page that has the line", () => {
    const js = shellJs + codeJs;
    expect(js).toContain("getElementById('code-cut')");
    expect(js).toContain("location.replace(cut.getAttribute('href') + location.hash)");
  });

  test("without script the notice says where a later line is", () => {
    expect(String(draw().content)).toContain("lands once you show all lines");
  });
});
