import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { addedProblems, parseAdded, reviewProblems } from "../src/kernel/review_rules.ts";
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

test("a declared name ending in an underscore is refused in src, naming the rule", () => {
  const [p, ...rest] = reviewProblems([
    { path: "src/a.ts", text: "const ok = 1;\nconst split_ = 2;\nlet _x = 3;\nfunction f_() {}" },
  ]);
  expect(p).toContain('rule "a name does not end in an underscore"');
  expect(p).toContain("src/a.ts:2");
  expect(rest).toHaveLength(1);
  expect(reviewProblems([{ path: "src/web/render/vendor/y.ts", text: "const v_ = 1;" }])).toEqual([]);
});

test("the repository's own tests pass the rules", () => {
  expect(reviewRefusal()).toEqual([]);
  expect(readdirSync("test").length).toBeGreaterThan(0);
  expect(readFileSync("test/toolbar-camera.test.ts", "utf8")).toContain("helpers/toolbar-boot.ts");
});

// Built apart so this file does not itself trip the rules it tests.
const CAST = "f(row as" + " never);";
const SLEEP = "await Bun." + "sleep(20);";
const TIMEOUT = "await new Promise((r) => set" + "Timeout(r, 5));";
const diffOf = (path: string, ...lines: string[]) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -3,0 +4,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;

test("parseAdded gives the added lines with their new line numbers", () => {
  expect(parseAdded(diffOf("test/a.test.ts", "x", "y"))).toEqual([
    { path: "test/a.test.ts", line: 4, text: "x" },
    { path: "test/a.test.ts", line: 5, text: "y" },
  ]);
});

test("an added cast to never in a test is refused, naming the rule and line; in src it is not", () => {
  const [p, ...rest] = addedProblems(parseAdded(diffOf("test/a.test.ts", "ok();", CAST)));
  expect(rest).toEqual([]);
  expect(p).toContain("a test builds the real input");
  expect(p).toContain("test/a.test.ts:5");
  expect(addedProblems(parseAdded(diffOf("src/a.ts", CAST)))).toEqual([]);
});

test("an added real-timer wait in a test is refused unless it says why", () => {
  const bad = addedProblems(parseAdded(diffOf("test/a.test.ts", SLEEP, TIMEOUT)));
  expect(bad).toHaveLength(2);
  expect(bad[0]).toContain('rule "a test does not wait on a real timer"');
  expect(addedProblems(parseAdded(diffOf("test/a.test.ts", `${SLEEP} // real-timer: the socket needs it`)))).toEqual([]);
});

test("an added comment line over 100 columns is refused", () => {
  const long = `// ${"word ".repeat(21)}`;
  expect(long.length).toBeGreaterThan(100);
  const [p] = addedProblems(parseAdded(diffOf("src/a.ts", long)));
  expect(p).toContain('rule "a comment line is wrapped at 100 columns"');
  expect(addedProblems(parseAdded(diffOf("src/a.ts", "// short")))).toEqual([]);
  expect(addedProblems(parseAdded(diffOf("docs/a.md", long)))).toEqual([]);
});

test("a `++ x` line added is read as a line, not as a file header", () => {
  const diff = diffOf("test/a.test.ts", "++ " + CAST);
  expect(parseAdded(diff)).toEqual([{ path: "test/a.test.ts", line: 4, text: "++ " + CAST }]);
});

test("a long multiplication continuation is code, a long block-comment line is a comment", () => {
  const long = "  * 1000 * rate " + "+ x".repeat(40);
  expect(addedProblems(parseAdded(diffOf("src/a.ts", "const t = a", long)))).toEqual([]);
  const wrapped = ["/**", " * " + "word ".repeat(25), " */"];
  const out = addedProblems(parseAdded(diffOf("src/a.ts", ...wrapped)));
  expect(out).toHaveLength(1);
  expect(out[0]).toContain("src/a.ts:5");
});
