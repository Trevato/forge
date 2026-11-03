/**
 * Co-authors a landing keeps: a squash folds a pull's commits into one, and
 * the `Co-authored-by` trailers they carried must survive it, or the people
 * they credit read as strangers to the change.
 */

import { runGitCapture } from "./env.ts";
import { isSafeOid } from "./guard.ts";

/** At most this many co-authors ride a landing. */
export const COAUTHORS_MAX = 20;

const TRAILER = /^co-authored-by:[ \t]*([^<>\s][^<>\r\n]{0,99}?)[ \t]*<([^<>\s@]{1,100}@[^<>\s@]{1,200})>[ \t]*$/i;

/**
 * The `Co-authored-by: Name <email>` lines in commit `messages`, as written
 * canonically, one per person (by email), first seen first. A line that is
 * not exactly name and address is dropped; `skip` lists emails already
 * credited on the landing.
 */
export function coAuthorLines(messages: readonly string[], skip: readonly string[] = []): string[] {
  const seen = new Set(skip.map((e) => e.toLowerCase()));
  const out: string[] = [];
  for (const message of messages)
    for (const line of message.split("\n")) {
      const m = TRAILER.exec(line.replace(/\r$/, ""));
      if (m === null) continue;
      const email = m[2]!.toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      out.push(`Co-authored-by: ${m[1]!} <${m[2]!}>`);
      if (out.length >= COAUTHORS_MAX) return out;
    }
  return out;
}

/** The commit messages of `base..head` in `dir`, newest first; none when git cannot say. */
export async function messagesBetween(dir: string, base: string, head: string): Promise<string[]> {
  if (!isSafeOid(base) || !isSafeOid(head)) return [];
  const r = await runGitCapture(["log", "--format=%B%x00", "-n", "200", `${base}..${head}`], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout.split("\0").filter((m) => m.trim() !== "");
}
