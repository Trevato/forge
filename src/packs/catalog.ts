/**
 * The packs this forge ships: every `packs/<name>/pack.json` in the
 * repository, parsed once. A file that fails to parse is left out and named
 * in `problems`, which a test keeps empty, so a bad pack never reaches a page.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parsePack, type Pack } from "./pack.ts";

const ROOT = join(import.meta.dir, "..", "..", "packs");

export function loadCatalog(root = ROOT): { packs: readonly Pack[]; problems: readonly string[] } {
  const packs: Pack[] = [];
  const problems: string[] = [];
  if (!existsSync(root)) return { packs, problems };
  for (const dir of readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = join(root, dir.name, "pack.json");
    if (!existsSync(file)) continue;
    const parsed = parsePack(readFileSync(file, "utf8"));
    if (!parsed.ok) problems.push(`${dir.name}: ${parsed.error}`);
    else if (parsed.value.name !== dir.name) problems.push(`${dir.name}: name must match the directory`);
    else packs.push(parsed.value);
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return { packs, problems };
}

let cached: ReturnType<typeof loadCatalog> | undefined;
/** The shipped catalog, read once per process. */
export const catalog = (): ReturnType<typeof loadCatalog> => (cached ??= loadCatalog());

export const packNamed = (name: string): Pack | undefined => catalog().packs.find((p) => p.name === name);
