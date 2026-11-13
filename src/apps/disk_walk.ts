/**
 * Bytes allocated under directories, without following links, bounded. Its
 * own module so a worker can walk without loading the containment code.
 */

import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const DISK_WALK_MAX = 200_000;

export function diskBytes(dirs: readonly string[]): number {
  let total = 0;
  let seen = 0;
  const walk = (path: string): void => {
    if (++seen > DISK_WALK_MAX) return;
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    total += st.blocks * 512;
    if (!st.isDirectory()) return;
    let names: string[];
    try {
      names = readdirSync(path);
    } catch {
      return;
    }
    for (const name of names) walk(join(path, name));
  };
  for (const dir of dirs) if (existsSync(dir)) walk(dir);
  return total;
}
