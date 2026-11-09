/**
 * Rule `header-width`: a file's comments (the leading block and every comment-only
 * line after it) keep every line within MAX_WIDTH columns. Reviewers kept
 * asking to "wrap the header comment, it is now one very long line" (#8162,
 * #8084, #9716, #8264) and to rewrap long comment lines (#8957, #9222, #9627,
 * #9943); this says it for them (#9960, #10140). Files already over are listed in `header-width-allow.json`
 * and only leave it: a new offender fails, and so does a listed file that
 * is now clean, so the list shrinks and never grows.
 */

import { Glob } from "bun";

export const MAX_WIDTH = 160;

/**
 * Lines of comment longer than MAX_WIDTH, as `file:line`: the leading block
 * and every later comment-only line (`//` or inside a block comment), the
 * "this comment line runs far past the others" finding (#8957, #9222, #9627,
 * #9943). A line holding a URL is exempt: it cannot be wrapped.
 */
export function longHeaderLines(file: string, text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  text.split("\n").forEach((line, i) => {
    const t = line.trim();
    const starts = inBlock || t.startsWith("//") || t.startsWith("/*");
    if (!inBlock && t.startsWith("/*") && !t.includes("*/")) inBlock = true;
    else if (inBlock && t.includes("*/")) inBlock = false;
    if (starts && line.length > MAX_WIDTH && !/https?:\/\//.test(line)) out.push(`${file}:${i + 1}`);
  });
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
  for (const [, hits] of bad) console.error(`header-width: comment line over ${MAX_WIDTH} columns, rewrap it: ${hits.join(", ")}`);
  process.exit(bad.length ? 1 : 0);
}
