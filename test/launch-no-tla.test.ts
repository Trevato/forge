// @tree-scan: lists the repository through a walk it hands a rooted path.
/**
 * 0.7.283 did not boot on real data: a lazy require() of the crew's flow-label dispatcher reached a module
 * graph that awaits at its top, and Bun refuses to require() that. Lazy loads in src/ use import(), never require().
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const walk = (d: string): string[] =>
  readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });

test("no module in src/ loads another with require(): a graph with a top-level await refuses it at runtime", () => {
  const root = join(import.meta.dir, "..", "src");
  const offenders = walk(root).filter((f) => /\brequire\(\s*["'`]\.\.?\//.test(readFileSync(f, "utf8")));
  expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
});

