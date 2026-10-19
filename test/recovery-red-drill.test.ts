import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const doc = read("docs/RECOVERY.md");
const section = doc.split("## When the drill is red")[1]?.split(/\n## /)[0] ?? "";

const names = (union: string | undefined): string[] =>
  [...(union ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);

const steps = names(read("src/snapshot/drill.ts").match(/type DrillStep =([^;]+);/)?.[1]);
const phases = names(read("src/snapshot/restore.ts").match(/phase: ([^;\n]+);/)?.[1]);

test("the code names steps and phases to look for", () => {
  expect(steps).toContain("fetch");
  expect(phases).toContain("bundles");
});

test("every drill step and restore phase has an entry in 'When the drill is red'", () => {
  expect(section).not.toBe("");
  for (const name of [...steps, ...phases])
    expect(section, `no entry for ${name}`).toMatch(new RegExp(`^- \\*\\*${name}\\*\\* — `, "m"));
});
