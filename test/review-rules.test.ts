import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { reviewProblems } from "../src/kernel/review_rules.ts";
import { reviewRefusal } from "../scripts/gate.ts";

// Built apart so this file does not itself import a test file.
const T = ".test";

test("a test that imports another test file is refused, naming the rule, file and line", () => {
  const [p, ...rest] = reviewProblems([
    { path: "test/a.test.ts", text: `import { x } from "bun:test";\nimport { boot } from "./b${T}.ts";\n` },
  ]);
  expect(rest).toEqual([]);
  expect(p).toContain('rule "a test file does not import another test file"');
  expect(p).toContain("test/a.test.ts:2");
  expect(p).toContain("test/helpers/");
});

test("dynamic and extensionless imports of a test file are caught too", () => {
  expect(reviewProblems([{ path: "test/a.test.ts", text: `const m = await import("../test/b${T}");` }])).toHaveLength(1);
});

test("a helper import, a source import and a non-test file pass", () => {
  expect(
    reviewProblems([
      { path: "test/a.test.ts", text: 'import { boot } from "./helpers/toolbar-boot.ts";\nimport { f } from "../src/x.ts";' },
      { path: "test/helpers/h.ts", text: `import "./b${T}.ts";` },
    ]),
  ).toEqual([]);
});

test("the repository's own tests pass the rules", () => {
  expect(reviewRefusal()).toEqual([]);
  expect(readdirSync("test").length).toBeGreaterThan(0);
  expect(readFileSync("test/toolbar-camera.test.ts", "utf8")).toContain("helpers/toolbar-boot.ts");
});
