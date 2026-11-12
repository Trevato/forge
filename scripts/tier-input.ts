/**
 * What `fastSet` reads from the working tree, for the two scripts that ask
 * it: `test-shards.ts --tier fast` and `fast.ts`. One reading, so the
 * check and the builder's preview cannot drift apart.
 */

import { readFileSync } from "node:fs";
import { importsOf } from "../src/checks/tiers.ts";
import { parseImpact } from "../src/checks/impact.ts";
import { treeScans } from "../src/checks/scans.ts";

/** A file's relative imports as candidate paths (an extensionless one also as `.ts`); `[]` when unreadable. Memoised. */
export function importsReader(): (file: string) => string[] {
  const cache = new Map<string, string[]>();
  return (file) => {
    let found = cache.get(file);
    if (found === undefined) {
      try {
        found = importsOf(readFileSync(file, "utf8"), file).flatMap((path) =>
          /\.[cm]?[jt]sx?$/.test(path) ? [path] : [path, `${path}.ts`],
        );
      } catch {
        found = [];
      }
      cache.set(file, found);
    }
    return found;
  };
}

/**
 * The impact map at `path`, or `undefined` when there is none yet (the
 * import guess stands) or it is refused (said through `say`).
 */
export function readImpact(
  path: string,
  name: string,
  say: (line: string) => void,
): Map<string, string[]> | undefined {
  try {
    const parsed = parseImpact(readFileSync(path, "utf8"));
    if (parsed.ok) return parsed.value;
    say(`${name} refused (${parsed.error}); guessing by imports`);
  } catch {
    // no map yet
  }
  return undefined;
}

/** The gate's tests that read the tree (`src/checks/scans.ts`), read from the working tree. */
export function scansIn(
  tests: readonly string[],
  imports: (file: string) => readonly string[],
): Map<string, string> {
  return treeScans(
    tests,
    (file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return undefined;
      }
    },
    imports,
  );
}
