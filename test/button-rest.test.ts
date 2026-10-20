/** #3039: a button never shows a spinner at rest; only its own busy state turns the loader. */
import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { components } from "../src/web/style/components.ts";

describe("buttons at rest", () => {
  test("stylesheet stops the loader inside a button unless it is aria-busy", () => {
    expect(components).toContain(".btn .ico-loader { animation-play-state: paused; }");
    expect(components).toContain('.btn[aria-busy="true"] .ico-loader');
  });
  // `.ico-loader` animates, so a btn(...) whose icon is "loader" looks busy
  // before anyone clicks it.
  test("no btn(...) call in src/web rests on the loader icon", async () => {
    const offenders: string[] = [];
    for (const path of new Glob("src/web/**/*.ts").scanSync(".")) {
      const text = await Bun.file(path).text();
      for (const m of text.matchAll(/\bbtn\(/g)) {
        // Read the call's argument list by matching parentheses.
        let depth = 0;
        let end = m.index! + m[0].length - 1;
        for (; end < text.length; end++) {
          if (text[end] === "(") depth++;
          else if (text[end] === ")" && --depth === 0) break;
        }
        const call = text.slice(m.index!, end + 1);
        if (/\bicon:\s*["']loader["']/.test(call)) {
          const line = text.slice(0, m.index).split("\n").length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
