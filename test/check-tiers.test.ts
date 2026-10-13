import { describe, expect, test } from "bun:test";
import {
  duration,
  fastSet,
  importsOf,
  landVerdict,
  tierLine,
} from "../src/checks/tiers.ts";
import { parseCheck } from "../src/apps/manifest.ts";

const tests = [
  "test/snapshot-store.test.ts",
  "test/snapshot.test.ts",
  "test/web-phone.test.ts",
  "test/deep.test.ts",
  "test/tiny.test.ts",
];
const times = new Map([
  ["test/snapshot-store.test.ts", 30],
  ["test/snapshot.test.ts", 30],
  ["test/web-phone.test.ts", 90],
  ["test/deep.test.ts", 20],
  ["test/tiny.test.ts", 0.2],
]);
const graph: Record<string, string[]> = {
  "test/snapshot.test.ts": ["src/snapshot/service.ts"],
  "src/snapshot/service.ts": ["src/snapshot/store.ts"],
  "test/deep.test.ts": ["src/a.ts"],
  "src/a.ts": ["src/b.ts"],
  "src/b.ts": ["src/c.ts"],
  "src/c.ts": ["src/d.ts"],
};
const imports = (file: string): string[] => graph[file] ?? [];

describe("the fast set", () => {
  const plan = fastSet({
    changed: ["src/snapshot/store.ts"],
    tests,
    imports,
    times,
  });

  test("a diff touching src/snapshot/store.ts runs the snapshot tests, not web-phone", () => {
    expect(plan.files).toContain("test/snapshot-store.test.ts");
    expect(plan.files).toContain("test/snapshot.test.ts");
    expect(plan.files).not.toContain("test/web-phone.test.ts");
  });

  test("a quick test always runs, and each file says why", () => {
    expect(plan.files).toContain("test/tiny.test.ts");
    expect(plan.why.get("test/snapshot-store.test.ts")).toContain("named for");
    expect(plan.why.get("test/tiny.test.ts")).toBe("quick");
  });

  test("the import graph stops after two hops", () => {
    const far = fastSet({ changed: ["src/d.ts"], tests, imports, times });
    expect(far.files).not.toContain("test/deep.test.ts");
    const near = fastSet({ changed: ["src/c.ts"], tests, imports, times });
    expect(near.files).toContain("test/deep.test.ts");
  });

  test("a changed test, and a learned test run; an unknown one does not", () => {
    const more = fastSet({
      changed: ["test/web-phone.test.ts"],
      tests: [...tests, "test/new.test.ts"],
      imports,
      times,
      learned: ["test/deep.test.ts"],
    });
    expect(more.files).toContain("test/web-phone.test.ts");
    expect(more.files).toContain("test/deep.test.ts");
    expect(more.files).not.toContain("test/new.test.ts");
  });

  test("a plan over five minutes says so", () => {
    const slow = fastSet({
      changed: ["test/web-phone.test.ts"],
      tests,
      imports,
      times: new Map([["test/web-phone.test.ts", 400]]),
    });
    expect(slow.overBudget).toBe(true);
    expect(plan.overBudget).toBe(false);
  });
});

describe("importsOf", () => {
  test("resolves relative specifiers and leaves packages out", () => {
    const source = `import { a } from "../src/snapshot/store.ts";\nimport x from "node:fs";\nconst m = await import("./helper.ts");`;
    expect(importsOf(source, "test/x.test.ts")).toEqual([
      "src/snapshot/store.ts",
      "test/helper.ts",
    ]);
  });
});

describe("the checks line", () => {
  test("words", () => {
    expect(tierLine("green", 220)).toBe(
      "fast tier: green in 3m40s · full gate runs on land",
    );
    expect(tierLine("running")).toBe(
      "fast tier: running · full gate runs on land",
    );
    expect(tierLine("red", 45)).toBe("fast tier: red in 45s");
    expect(duration(60)).toBe("1m00s");
  });
});

describe("the full gate on land", () => {
  test("green lands", () => {
    expect(landVerdict(true, [])).toEqual({ lands: true });
  });

  test("red reopens the pull, names the tests, and teaches their files", () => {
    const verdict = landVerdict(
      false,
      ["snapshot > restores", "web > phone"],
      ["test/snapshot.test.ts", "test/snapshot.test.ts"],
    );
    if (verdict.lands) throw new Error("a red gate landed");
    expect(verdict.reopen).toBe(true);
    expect(verdict.comment).toContain("- snapshot > restores");
    expect(verdict.comment).toContain("- web > phone");
    expect(verdict.learn).toEqual(["test/snapshot.test.ts"]);
  });

  test("red with no test named still reopens", () => {
    const verdict = landVerdict(false, []);
    expect(verdict.lands).toBe(false);
  });
});

describe("forge.json", () => {
  test("check declares fast and full", () => {
    const parsed = parseCheck(
      JSON.stringify({ check: { run: "a", fast: "b", full: "c" } }),
      undefined,
    );
    if (!parsed.ok || parsed.value === undefined) throw new Error("refused");
    expect(parsed.value.fast).toBe("b");
    expect(parsed.value.full).toBe("c");
    const plain = parseCheck(JSON.stringify({ check: { run: "a" } }), undefined);
    if (!plain.ok || plain.value === undefined) throw new Error("refused");
    expect(plain.value.fast).toBeNull();
    expect(plain.value.full).toBe("a");
  });
});
