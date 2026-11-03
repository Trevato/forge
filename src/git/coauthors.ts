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

/**
 * The authors of `base..head` as `Co-authored-by` lines, the crew's agents
 * (whose address ends `@agents.invalid`) left out: they are the landing's own
 * author. A person who wrote a commit stays credited when it is squashed.
 */
export async function authorLinesBetween(dir: string, base: string, head: string): Promise<string[]> {
  if (!isSafeOid(base) || !isSafeOid(head)) return [];
  const r = await runGitCapture(["log", "--format=Co-authored-by: %an <%ae>", "-n", "200", `${base}..${head}`], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").filter((l) => l !== "" && !/@agents\.invalid>$/i.test(l));
}

/** The commit messages of `base..head` in `dir`, newest first; none when git cannot say. */
export async function messagesBetween(dir: string, base: string, head: string): Promise<string[]> {
  if (!isSafeOid(base) || !isSafeOid(head)) return [];
  const r = await runGitCapture(["log", "--format=%B%x00", "-n", "200", `${base}..${head}`], { cwd: dir });
  if (r.code !== 0) return [];
  return r.stdout.split("\0").filter((m) => m.trim() !== "");
}

/** What a landed commit says of who else made it, per commit; a commit never changes, so it is asked once. */
const credited = new Map<string, readonly string[]>();

/**
 * The names credited on each landed commit in `oids`, beyond the one who
 * committed it (its own `Co-authored-by` names the lander). Commits git
 * cannot read are left out.
 */
export async function creditsOf(dir: string, oids: readonly string[]): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  const todo: string[] = [];
  for (const oid of oids) {
    if (!isSafeOid(oid)) continue;
    const known = credited.get(`${dir}\0${oid}`);
    if (known === undefined) todo.push(oid);
    else out.set(oid, known);
  }
  if (todo.length > 0) {
    const r = await runGitCapture(["log", "--no-walk=unsorted", "--format=%H%x01%ce%x01%B%x02", ...todo], { cwd: dir });
    if (r.code === 0)
      for (const block of r.stdout.split("\x02")) {
        const [oid, committer, message] = block.trim().split("\x01");
        if (!oid || committer === undefined || message === undefined) continue;
        const names: string[] = [];
        for (const line of coAuthorLines([message], [committer])) {
          const name = /^Co-authored-by: (.*) <[^<>]*>$/.exec(line)?.[1];
          if (name !== undefined) names.push(name);
        }
        credited.set(`${dir}\0${oid}`, names);
        out.set(oid, names);
      }
  }
  return out;
}

/**
 * The `Co-authored-by` lines a squash of `base..head` keeps: those its commits
 * carry and its commits' human authors, once per address, less `skip`.
 */
export async function squashCredits(dir: string, base: string, head: string, skip: readonly string[]): Promise<string[]> {
  return coAuthorLines([...(await messagesBetween(dir, base, head)), ...(await authorLinesBetween(dir, base, head))], skip);
}
