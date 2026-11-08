/**
 * Unreached modules (#6500): each `src/**\/*.ts` that no entry point reaches by
 * following imports. A module only its tests import is done by no one's reckoning
 * (docs/VISION.md: done means reachable). `scripts/unreached-allow.json` is
 * what main carries today; `test/unreached.test.ts` keeps it shrinking.
 *
 * An import is a static `from "./x"`, a side-effect `import "./x"`, or an
 * `import("./x")` (quotes or backticks, any whitespace), resolved against the importing file's directory.
 * Imports from `scripts/` count as reaching what they name.
 */

import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** Files something starts, by name or by path, so nothing imports them. */
export const ENTRIES = [
  "src/main.ts",
  "src/cli/main.ts",
  "src/tui/main.ts",
  "src/chaos/worker.ts",
  "src/chaos/run.ts",
  "src/release/boot.ts",
  "src/git/hook-entry.ts",
];

/** Scripts the check and operators run, and the benches run at release, are callers too: their imports count. */
const SCRIPTS = ["scripts/**/*.ts", "bench/**/*.ts"];

/** Not modules: tests, and migrations, which the runner finds by listing the directory. */
const NOT_MODULES = /(?:\.test\.ts$|^src\/core\/migrations\/)/;

const SPEC = /(?:\bfrom\s*|\bimport\s*\(?\s*)["'`](\.{1,2}\/[^"'`]*)["'`]/g;

/** A module named as a URL beside this one, the way a `Bun.build` entry point is: `new URL("./x.ts", import.meta.url)`. */
const URL_SPEC = /\bnew\s+URL\(\s*["'`](\.{1,2}\/[^"'`]*)["'`]\s*,\s*import\.meta\.url\s*\)/g;

/** The src/ file a relative specifier names, among `files`, or undefined. */
function resolve(from: string, spec: string, files: Set<string>): string | undefined {
  const base = normalize(join(dirname(from), spec)).replace(/\.(js|ts)$/, "");
  return [`${base}.ts`, `${base}/index.ts`].find((c) => files.has(c));
}

/** The `src/**\/*.ts` files no entry point reaches through imports, sorted. */
export function unreached(root: string): string[] {
  const files = new Set(
    [...new Bun.Glob("src/**/*.ts").scanSync({ cwd: root })].filter((f) => !f.endsWith(".d.ts") && !NOT_MODULES.test(f)),
  );
  const reached = new Set<string>(ENTRIES.filter((e) => files.has(e)));
  const queue = [...reached, ...SCRIPTS.flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: root })])];
  for (let file = queue.pop(); file; file = queue.pop()) {
    const text = readFileSync(join(root, file), "utf8");
    for (const m of [...text.matchAll(SPEC), ...text.matchAll(URL_SPEC)]) {
      const target = resolve(file, m[1]!, files);
      if (target && !reached.has(target)) {
        reached.add(target);
        queue.push(target);
      }
    }
  }
  return [...files].filter((f) => !reached.has(f)).sort();
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const list = unreached(root);
  if (process.argv.includes("--json")) console.log(JSON.stringify(list, null, 2));
  else for (const f of list) console.log(f);
}
