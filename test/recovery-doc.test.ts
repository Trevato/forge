import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const doc = read("docs/RECOVERY.md");

test("the doc names every variable the store reads", () => {
  const vars = new Set(
    [...read("src/snapshot/store.ts").matchAll(/env\["(S3_[A-Z_]+)"\]/g)].map(
      (m) => m[1]!,
    ),
  );
  expect(vars.size).toBeGreaterThanOrEqual(5);
  for (const v of vars) expect(doc).toContain(v);
  expect(doc).toContain("FORGE_SNAPSHOT_PASSPHRASE");
});

test("the doc's restore command is the one restore.ts prints", () => {
  const printed = read("src/snapshot/restore.ts").match(
    /"usage: (bun run src\/snapshot\/restore\.ts [^"]+)"/,
  )?.[1];
  expect(printed).toBeDefined();
  expect(doc).toContain(`    ${printed}\n`);
});

test("the doc's prefix and object names are the ones snapshot.ts writes", () => {
  const prefix = read("src/snapshot/snapshot.ts").match(
    /SNAPSHOT_PREFIX = "([^"]+)"/,
  )?.[1];
  expect(prefix).toBe("snapshots/");
  expect(doc).toContain(`${prefix}<name>/`);
  const wrapped = read("src/snapshot/wrap.ts").match(
    /WRAPPED_KEY = "([^"]+)"/,
  )?.[1];
  expect(wrapped).toBeDefined();
  expect(doc).toContain(wrapped!);
  // Each layout path the doc lists is one snapshot.ts puts, or restore.ts reads.
  const snap = read("src/snapshot/snapshot.ts");
  for (const p of ["forge.db", "ssh/", "repos/", "apps/", "runs/", "manifest.json"])
    expect(snap).toContain(p);
  expect(snap).toContain(".bundle");
  expect(doc).toContain("<repo>.bundle");
  expect(doc).not.toContain("manual/");
  expect(doc).not.toContain("openssl");
});

test("`latest` is a name restore.ts accepts, not an object", () => {
  expect(read("src/snapshot/restore.ts")).toContain('name === "latest"');
  expect(doc).toContain("`latest`");
});

test("what a snapshot lacks is what snapshot.ts leaves out", () => {
  const head = read("src/snapshot/snapshot.ts").slice(0, 1200);
  expect(head).toContain("clones");
  expect(doc).toContain("clones");
  // Sealed values and app variables live sealed in the database.
  expect(read("src/core/app_env.ts")).toContain("sealed at rest");
  expect(read("src/snapshot/restore.ts")).toContain("sealedMissing");
  expect(doc).toContain("App variables, which are sealed");
  expect(doc).toContain("/api/v1/health");
});

test("the doc fits one printed side", () => {
  expect(doc.split("\n").length).toBeLessThanOrEqual(80);
});

test("the doc says where the drill's verdicts are posted, and names its steps", () => {
  expect(doc).toContain("FORGE_RECOVERY_ISSUE");
  expect(doc).toContain("FORGE_RECOVERY_REPO");
  expect(doc).toContain("/api/v1/health");
  const steps = read("src/snapshot/drill.ts").match(/type DrillStep = ([^;]+);/)?.[1];
  for (const step of steps!.matchAll(/"(\w+)"/g)) expect(doc).toContain(step[1]!);
});
