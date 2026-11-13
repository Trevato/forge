/**
 * The repository's source as an MCP resource, for a runtime with no outbound
 * network: `forge://source/<owner>/<name>@<ref>[?path=<dir>]`, a base64 gzip
 * tar of the tree at that ref (the bytes `/:owner/:name/archive/<ref>.tar.gz`
 * serves). Small by rule: a resource travels inside a conversation, so the
 * whole of a large repository is refused with the advice to ask for a
 * directory with `path`. Each read is admitted like the HTTP route: the
 * per-source minute and the at-once cap in `http/archive_limit.ts`.
 */

import { canRead, getRepo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import { archiveAt } from "../../git/archive.ts";
import { isSafeRef, isSafeTreePath } from "../../git/guard.ts";
import { repoDir } from "../../git/repos.ts";
import { takeArchive } from "../archive_limit.ts";
import type { Ctx } from "../context.ts";

export const SOURCE_PREFIX = "forge://source/";
export const SOURCE_TEMPLATE = `${SOURCE_PREFIX}{owner}/{name}@{ref}{?path}`;
/** The most gzip bytes one resource carries. */
export const SOURCE_RESOURCE_BYTES = 4 * 1024 * 1024;

export type SourceRead =
  | { ok: true; uri: string; mimeType: string; blob: string }
  | { ok: false; message: string };

const SHAPE = /^forge:\/\/source\/([^/@?]+)\/([^/@?]+)@([^?]+)(?:\?path=(.+))?$/;

export async function readSource(ctx: Ctx, user: User | undefined, uri: string): Promise<SourceRead> {
  const m = SHAPE.exec(uri);
  if (m === null) return { ok: false, message: `no resource ${uri}` };
  const [, owner = "", name = "", rawRef = "", rawPath] = m;
  let ref: string;
  let path: string | undefined;
  try {
    ref = decodeURIComponent(rawRef);
    path = rawPath === undefined ? undefined : decodeURIComponent(rawPath);
  } catch {
    return { ok: false, message: `no resource ${uri}` };
  }
  const repo = getRepo(ctx.app.db, owner, name);
  if (!repo || !canRead(ctx.app.db, repo, user) || !isSafeRef(ref) || (path !== undefined && !isSafeTreePath(path)))
    return { ok: false, message: `no resource ${uri}` };
  // The same admission as the HTTP route (http/archive_limit.ts): one bucket
  // per source address, shared with /archive, and the forge-wide at-once cap.
  const turn = takeArchive(ctx.request);
  if (!turn.ok)
    return {
      ok: false,
      message: turn.why === "rate" ? `too many archives from this address: retry after ${turn.retryAfter} s` : `busy: retry after ${turn.retryAfter} s`,
    };
  const made = await archiveAt(repoDir(ctx.app.reposRoot, repo.ownerName, repo.name), ref, `${repo.name}-${ref.slice(0, 12)}`, path, SOURCE_RESOURCE_BYTES).finally(turn.done);
  if (!made.ok)
    return {
      ok: false,
      message: made.error === "too_large" ? `too large for a resource (over ${SOURCE_RESOURCE_BYTES} bytes gzipped): ask for a directory with ?path=src/…` : `no resource ${uri}`,
    };
  return { ok: true, uri, mimeType: "application/gzip", blob: Buffer.from(made.value.bytes).toString("base64") };
}
