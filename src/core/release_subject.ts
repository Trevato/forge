/**
 * What a release commit's subject says: `Release 0.7.251: <title> (#N);<title> (#M)`.
 * Read for a production deploy only, so the `app.serving` event can carry the
 * version and the pulls it brought live.
 */

import { commitLog } from "../git/read.ts";

export interface ReleasePull {
  title: string;
  number: number;
}

export interface Release {
  version: string;
  pulls: ReleasePull[];
}

const HEAD = /^Release (\d+\.\d+\.\d+): (.*)$/s;
const PULL = /(.*?) \(#(\d+)\)(?:;|$)/gs;

/** The release a subject names, or undefined for any other subject. */
export function parseReleaseSubject(subject: string): Release | undefined {
  const head = HEAD.exec(subject.trim());
  if (head === null) return undefined;
  const pulls: ReleasePull[] = [];
  for (const m of head[2]!.matchAll(PULL)) {
    const title = m[1]!.trim();
    const number = Number(m[2]);
    if (title !== "" && Number.isSafeInteger(number)) pulls.push({ title, number });
  }
  return { version: head[1]!, pulls };
}

/** The release a production commit is; previews and plain commits are none. */
export async function releaseOfCommit(
  repoDir: string,
  env: string,
  oid: string,
): Promise<Release | undefined> {
  if (env !== "production") return undefined;
  const log = await commitLog(repoDir, oid, { limit: 1 });
  if (!log.ok) return undefined;
  const subject = log.value[0]?.subject;
  return subject === undefined ? undefined : parseReleaseSubject(subject);
}
