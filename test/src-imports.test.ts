// @tree-scan: lists the repository through a walk it hands a rooted path.
/**
 * The image ships `src/` and nothing else (Dockerfile): a module under src/
 * that imports from scripts/ or test/ boots from the repository and crashes
 * in production. 0.7.166 did, on `src/release/prove.ts` importing
 * `scripts/smoke.ts`, and was down two hours (#2652). Every relative import
 * a src/ file makes, static or dynamic, must resolve inside src/.
 */

import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC = join(ROOT, "src");

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** Each relative import in `files` that resolves outside `src`, as `file -> specifier`. */
export function escapes(files: readonly string[], src: string): string[] {
  const scanners = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }) };
  const bad: string[] = [];
  for (const file of files) {
    const scanner = file.endsWith(".tsx") ? scanners.tsx : scanners.ts;
    for (const { path } of scanner.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (!path.startsWith(".")) continue;
      const target = resolve(dirname(file), path);
      if (target !== src && !target.startsWith(src + sep)) bad.push(`${relative(ROOT, file)} -> ${path}`);
    }
  }
  return bad;
}

test("nothing under src/ imports from outside src/ (scripts/, test/, …)", () => {
  expect(escapes(sources(SRC), SRC)).toEqual([]);
});

test("the walk sees a static import, a re-export and a dynamic import that leave src/", () => {
  const dir = join(process.env.TMPDIR ?? "/tmp", `src-imports-${process.pid}`);
  const src = join(dir, "src");
  const file = join(src, "release", "x.ts");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      'import { smoke } from "../../scripts/smoke.ts";',
      'export { h } from "../../test/helpers/h.ts";',
      'const m = await import("../../scripts/shards.ts");',
      'import { ok } from "../kernel/result.ts";',
      'const text = `import { lint } from "../../scripts/lint-design.ts";`;',
      "console.log(smoke, m, ok, text);",
    ].join("\n"),
  );
  try {
    expect(escapes([file], src).map((l) => l.split(" -> ")[1])).toEqual([
      "../../scripts/smoke.ts",
      "../../test/helpers/h.ts",
      "../../scripts/shards.ts",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
