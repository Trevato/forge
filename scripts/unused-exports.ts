/**
 * Dead code (#11842): an exported function, const or class under `src/` whose
 * name appears nowhere else in `src/`, `scripts/` or `bench/` outside tests.
 * Reviewers kept writing "X is never called; remove it" (#9639, #11255,
 * #11809, #10611); this says it for them. A test that alone calls it does not
 * count: done means reachable (docs/VISION.md).
 *
 * The match is by name across the whole non-test corpus, so a name used
 * anywhere (even in its own file) is alive; that errs toward silence, never
 * toward a false accusation. `scripts/unused-exports-allow.json` lists
 * "path name" pairs main carries today; `--write` prunes the ones that are
 * no longer dead (the test only reports those, so pulls do not conflict).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DECL = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)/gm;
const WORD = /[A-Za-z_$][\w$]*/g;

/** Non-test sources, by path: what counts as a caller. */
function corpus(root: string): Map<string, string> {
  const files = [...new Bun.Glob("{src,scripts,bench}/**/*.ts").scanSync({ cwd: root })].filter(
    (f) => !f.endsWith(".test.ts") && !f.endsWith(".d.ts"),
  );
  return new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
}

/** `"path name"` for each src/ export nothing but its declaration mentions, sorted. */
export function unusedExports(root: string): string[] {
  const text = corpus(root);
  const counts = new Map<string, number>();
  for (const t of text.values()) for (const m of t.matchAll(WORD)) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  const dead: string[] = [];
  for (const [file, t] of text) {
    if (!file.startsWith("src/")) continue;
    for (const m of t.matchAll(DECL)) if ((counts.get(m[1]!) ?? 0) < 2) dead.push(`${file} ${m[1]}`);
  }
  return dead.sort();
}

if (import.meta.main) {
  const list = unusedExports(new URL("..", import.meta.url).pathname);
  if (process.argv.includes("--write")) {
    // Prune only: entries still dead stay, so a new dead export is never silently allowed.
    const file = new URL("./unused-exports-allow.json", import.meta.url).pathname;
    const kept = (JSON.parse(readFileSync(file, "utf8")) as string[]).filter((e) => list.includes(e));
    writeFileSync(file, JSON.stringify(kept, null, 2) + "\n");
    console.log(`kept ${kept.length}`);
  } else
  if (process.argv.includes("--json")) console.log(JSON.stringify(list, null, 2));
  else for (const d of list) console.log(d);
}
