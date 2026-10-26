/**
 * A retirement issue already carried out. An issue whose title says a class
 * or rule "leaves the stylesheet" or "leaves §5d" can be handed out after
 * the work landed (#4691, #4616): the run then closes with nothing to
 * change. Before the picker hands one out, the names in it are looked for
 * on the base branch; when none is left, the crew writes the already-done
 * note with the commit that last touched them instead.
 *
 * Names are the backticked `.class` tokens of the title and body, nothing
 * else; an issue without them is never judged. Docs and tests may keep
 * saying a name after it is gone from the code, so they are not searched.
 */

import { runGit } from "../git/env.ts";

const RETIRES = /\bleaves?\s+(?:the\s+stylesheet|§\s*5d)/i;
const NAME = /`(\.[A-Za-z_][\w-]*)`/g;

/** The most names one issue is checked for, and commits it is answered with. */
const MOST = 20;
const COMMITS = 5;

/** The `.class` names a retirement issue lists; empty when it is not one. */
export function retiredNames(issue: { title: string; body: string }): string[] {
  if (!RETIRES.test(issue.title)) return [];
  const found = new Set<string>();
  for (const m of `${issue.title}\n${issue.body}`.matchAll(NAME)) found.add(m[1]!);
  return [...found].slice(0, MOST);
}

const escape = (s: string): string => s.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&");

/**
 * The commits that last touched these names, when none of them is left on
 * `branch` in the bare repository at `dir`. Empty when any name remains,
 * when git cannot say, or when no commit is found to name.
 */
export async function removedBy(
  dir: string,
  branch: string,
  names: readonly string[],
): Promise<string[]> {
  if (names.length === 0) return [];
  const ref = `refs/heads/${branch}`;
  for (const name of names) {
    const left = await runGit(
      ["grep", "-q", "-E", "-e", `${escape(name)}([^A-Za-z0-9_-]|$)`, ref, "--", ".", ":!docs", ":!test"],
      { cwd: dir },
    );
    // Exit 1 is "no match"; any other failure is "cannot say".
    if (left.ok || left.error.code !== 1) return [];
  }
  const oids: string[] = [];
  for (const name of names) {
    const last = await runGit(["log", "-n", "1", "--format=%H", `-S${name}`, ref], { cwd: dir });
    if (last.ok && /^[0-9a-f]{40}$/.test(last.value) && !oids.includes(last.value))
      oids.push(last.value);
  }
  return oids.slice(0, COMMITS);
}
