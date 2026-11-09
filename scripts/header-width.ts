/**
 * Rule `header-width`: a file's leading `/** … *​/` comment keeps every line
 * within MAX_WIDTH columns. Reviewers kept asking to "wrap the header comment,
 * it is now one very long line" (#8162, #8084, #9716, #8264); this says it
 * for them (#9960). Files already over are listed in `header-width-allow.json`
 * and only leave it: a new offender fails, and so does a listed file that
 * is now clean, so the list shrinks and never grows.
 */

import { Glob } from "bun";

export const MAX_WIDTH = 160;

/** Lines of the leading block comment longer than MAX_WIDTH, as `file:line`. */
export function longHeaderLines(file: string, text: string): string[] {
  const lines = text.split("\n");
  const out: string[] = [];
  if (!lines[0]?.startsWith("/**")) return out;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.length > MAX_WIDTH) out.push(`${file}:${i + 1}`);
    if (lines[i]!.trimEnd().endsWith("*/")) break;
  }
  return out;
}

/** Every source file with an over-wide header line, by path. */
export async function offenders(root = "."): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  for (const f of new Glob("{src,scripts,test}/**/*.ts").scanSync(root)) {
    const hits = longHeaderLines(f, await Bun.file(`${root}/${f}`).text());
    if (hits.length) found.set(f, hits);
  }
  return found;
}

if (import.meta.main) {
  const allowed = new Set<string>(await Bun.file("scripts/header-width-allow.json").json());
  const bad = [...(await offenders())].filter(([f]) => !allowed.has(f));
  for (const [, hits] of bad) console.error(`header-width: wrap to ${MAX_WIDTH} columns: ${hits.join(", ")}`);
  process.exit(bad.length ? 1 : 0);
}
