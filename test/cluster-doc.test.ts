import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JOB_LABELS } from "../src/checks/job_step.ts";

const root = join(import.meta.dir, "..");
const doc = readFileSync(join(root, "docs/CLUSTER.md"), "utf8");
const read = (f: string) => readFileSync(join(root, f), "utf8");

test("the doc names every FORGE_CHECKS_* variable placement.ts reads", () => {
  const vars = new Set([...read("src/checks/placement.ts").matchAll(/env\["(FORGE_CHECKS_[A-Z_]+)"\]/g)].map((m) => m[1]!));
  expect(vars.size).toBe(5);
  for (const v of vars) expect(doc).toContain(`\`${v}\``);
});

test("the doc names the label check pods carry", () => {
  for (const [k, v] of Object.entries(JOB_LABELS)) expect(doc).toContain(`${k}: "${v}"`);
});

test("the doc grants every verb jobs.ts uses", () => {
  const verbs = { POST: "create", GET: "get", DELETE: "delete" };
  const used = new Set([...read("src/cluster/jobs.ts").matchAll(/call\("(POST|GET|DELETE)"/g)].map((m) => m[1]!));
  for (const m of used) expect(doc).toContain(`"${verbs[m as keyof typeof verbs]}"`);
  expect(doc).toContain('"list"');
  expect(doc).toContain("pods/log");
});
