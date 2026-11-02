/**
 * The work on another forge, read and written in that forge's own JSON.
 *
 * A forge's issues, pulls and comments are not Gitea's: the author is
 * `authorName` (or `originAuthor` when the thread was itself brought across),
 * labels are `{name}`, a list pages by `next_cursor` and a thread by `next`.
 * Plain data in, plain data out: these turn one such value into the shape
 * every provider returns, and `ForgeProvider` does the calling.
 */

import type { RemoteComment, RemoteIssue } from "../types.ts";
import { asId, asNumber, asState, asString, asTime, field, labelNames } from "./http.ts";

const authorOf = (raw: unknown): string =>
  asString(field(raw, "originAuthor")) || asString(field(raw, "authorName"));

/** An issue, or a pull when it carries branches. */
export function toForgeWork(raw: unknown, webUrl: string, fullName: string): RemoteIssue {
  const created = asTime(field(raw, "createdAt")) ?? new Date().toISOString();
  const number = asNumber(field(raw, "number"));
  const base = asString(field(raw, "baseBranch"));
  const issue: RemoteIssue = {
    remoteId: asId(field(raw, "id")),
    number,
    title: asString(field(raw, "title")),
    body: asString(field(raw, "body")),
    author: authorOf(raw),
    state: asState(field(raw, "state")),
    labels: labelNames(field(raw, "labels")),
    createdAt: created,
    updatedAt: asTime(field(raw, "updatedAt")) ?? created,
    closedAt: asTime(field(raw, "closedAt")),
    htmlUrl: `${webUrl}/${fullName}/${base === "" ? "issues" : "pulls"}/${number}`,
    comments: asNumber(field(raw, "comments")),
  };
  if (base === "") return issue;
  return {
    ...issue,
    pull: {
      baseBranch: base,
      headBranch: asString(field(raw, "headBranch")),
      headRepo: asString(field(raw, "originHeadRepo")) || fullName,
      baseOid: asString(field(raw, "baseOid")),
      headOid: asString(field(raw, "headOid")),
      mergedAt: asTime(field(raw, "mergedAt")),
      draft: false,
    },
  };
}

/**
 * A comment, linked to its thread (a pull answers at `issues/N` too) at the
 * anchor the thread page gives it. A forge's comments carry no edit time of
 * their own; `updatedAt` is read when one does, else the creation time.
 */
export function toForgeComment(
  raw: unknown,
  webUrl: string,
  fullName: string,
  number: number,
): RemoteComment {
  const created = asTime(field(raw, "createdAt")) ?? new Date().toISOString();
  const id = asId(field(raw, "id"));
  return {
    remoteId: id,
    author: authorOf(raw),
    body: asString(field(raw, "body")),
    createdAt: created,
    updatedAt: asTime(field(raw, "updatedAt")) ?? created,
    htmlUrl: `${webUrl}/${fullName}/issues/${number}#c-${id}`,
  };
}

/** The cursor a list hands back, as the string the next call sends. */
export function forgeCursor(raw: unknown): string | null {
  const next = field(raw, "next_cursor") ?? field(raw, "next");
  return typeof next === "number" || (typeof next === "string" && next !== "") ? String(next) : null;
}
