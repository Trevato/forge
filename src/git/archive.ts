/**
 * A repository at one commit as a gzipped tar: the working copy an agent in a
 * sandbox with no git credential takes (`/:owner/:name/archive/<ref>.tar.gz`,
 * and the MCP resource of the same bytes). `git archive` writes the tree, so
 * nothing of `.git`, no history and no credential is in it. Bounded: a tree
 * over `MAX_ARCHIVE_BYTES` is refused rather than streamed.
 */

import { err, ok, type Result } from "../kernel/result.ts";
import { runGitRaw } from "./env.ts";
import { resolveOid } from "./merge.ts";

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;

/** The newest few archives by commit: a commit's tree never changes, so a held one is always right. */
const held = new Map<string, Uint8Array>();
const HELD_MAX = 3;
const HELD_BYTES = 24 * 1024 * 1024;

export type ArchiveError = "not_found" | "too_large";

export async function archiveAt(
  dir: string,
  ref: string,
  prefix: string,
  /** A directory or file of the tree to take alone; the whole tree when absent. */
  path?: string,
  /** Refuse (`too_large`) a gzip over this many bytes. */
  limit: number = MAX_ARCHIVE_BYTES,
): Promise<Result<{ oid: string; bytes: Uint8Array }, ArchiveError>> {
  const oid = await resolveOid(dir, ref);
  if (oid === undefined) return err("not_found");
  const key = `${dir}\0${oid}\0${path ?? ""}`;
  const hit = held.get(key);
  if (hit !== undefined) return hit.length > limit ? err("too_large") : ok({ oid, bytes: hit });
  const tar = await runGitRaw(["--literal-pathspecs", "archive", "--format=tar", `--prefix=${prefix}/`, oid, ...(path === undefined ? [] : ["--", path])], {
    cwd: dir,
    maxBytes: MAX_ARCHIVE_BYTES,
    timeoutMs: 20_000,
  });
  if (!tar.ok) return err(tar.error.code === -2 ? "too_large" : "not_found");
  const bytes = Bun.gzipSync(new Uint8Array(tar.value));
  if (bytes.length > limit) return err("too_large");
  if (bytes.length <= HELD_BYTES) {
    held.set(key, bytes);
    while (held.size > HELD_MAX) held.delete(held.keys().next().value as string);
  }
  return ok({ oid, bytes });
}
