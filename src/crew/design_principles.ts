/**
 * The principles that open docs/DESIGN.md, as the crew's briefs carry them:
 * the numbered list under "The principles, in short.", one line each, read
 * once at load. A reviewer of a `src/web/` pull is given them and asked for a
 * finding per principle broken; the builder brief points to the same lines.
 * The image ships `docs/DESIGN.md` beside `src/` (Dockerfile); a missing file
 * reads as no principles rather than a boot failure.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DESIGN_PATH = "docs/DESIGN.md";

/** How a brief names the lines, so the builder and the reviewer read the same ones. */
export const DESIGN_POINTER = "the principles that open docs/DESIGN.md";

/** The numbered lines of the first list after "The principles, in short.", in order. */
export function designPrinciples(md: string): string[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.startsWith("**The principles, in short.**"));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\d+\. /.test(line)) out.push(line);
    else if (out.length > 0) break;
  }
  return out;
}

/** The principles in the file at `path`; none when it is missing or unreadable. */
export function loadDesignPrinciples(path: string): string[] {
  try {
    return designPrinciples(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export const DESIGN_PRINCIPLES: readonly string[] = loadDesignPrinciples(
  join(import.meta.dir, "..", "..", DESIGN_PATH),
);
