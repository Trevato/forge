/**
 * docs/PRINCIPLES.md as the forge's own agents read it: the principle lines
 * only, so the file's prose around them never reaches a brief. The image
 * ships `docs/PRINCIPLES.md` beside `src/` (Dockerfile); a missing file reads
 * as no principles rather than a boot failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PRINCIPLES_PATH = "docs/PRINCIPLES.md";

/** The bullet lines of `md`, each as one sentence without its markdown. */
export function principleLines(md: string): string[] {
  return md
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).replace(/\*\*/g, "").replace(/ Enforced by:.*$/, ""));
}

/** The principles in the file at `path`; none when it is missing or unreadable. */
export function loadPrinciples(path: string): string[] {
  try {
    return principleLines(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export const PRINCIPLES: readonly string[] = loadPrinciples(join(import.meta.dir, "..", "..", PRINCIPLES_PATH));
