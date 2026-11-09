import { expect, test } from "bun:test";
import allowed from "../scripts/header-width-allow.json";
import { longHeaderLines, MAX_WIDTH, offenders } from "../scripts/header-width.ts";

test("a header line over the width is named, a wrapped one is not", () => {
  const long = `/**\n * ${"word ".repeat(40)}\n */\nconst x = 1;\n`;
  expect(longHeaderLines("a.ts", long)).toEqual(["a.ts:2"]);
  expect(longHeaderLines("a.ts", "/**\n * short\n */\n")).toEqual([]);
  // later comment-only lines count (#8957, #9222, #9627, #9943); code and URLs do not
  expect(longHeaderLines("a.ts", `/**\n * ok\n */\n// ${"x ".repeat(100)}\n`)).toEqual(["a.ts:4"]);
  expect(longHeaderLines("a.ts", `x();\n  /* ${"x ".repeat(100)}\n  ${"y ".repeat(100)}*/\n`)).toEqual(["a.ts:2", "a.ts:3"]);
  expect(longHeaderLines("a.ts", `const s = "${"x".repeat(200)}";\n`)).toEqual([]);
  expect(longHeaderLines("a.ts", `// see https://e.com/${"x".repeat(200)}\n`)).toEqual([]);
});

test("rule header-width: wrap a file's header comment to the width; the allow list only shrinks", async () => {
  const found = await offenders();
  const ok = new Set<string>(allowed);
  const fresh = [...found].filter(([f]) => !ok.has(f)).flatMap(([, h]) => h);
  expect(fresh, `rule header-width: header comment lines over ${MAX_WIDTH} columns, wrap them: ${fresh.join(", ")}`).toEqual([]);
  const stale = [...ok].filter((f) => !found.has(f));
  expect(stale, `rule header-width: now wrapped, remove from scripts/header-width-allow.json: ${stale.join(", ")}`).toEqual([]);
});
