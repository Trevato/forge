/**
 * A repository we hold: git for the objects, the database for the
 * conversation. Every read here is the read the pages and API routes already
 * do — deliberately, so moving a page onto `RepoSource` is a mechanical
 * change rather than a rewrite with new behaviour hiding in it.
 *
 * Nothing in this file decides policy. `sourceFor` has already checked
 * `canRead`; what is left is shape.
 */

import { pullProposalOf } from "../core/proposal_token.ts";
import { mayView, sealedScope } from "../core/sealed.ts";
import type { App } from "../app.ts";
import {
  commentCounts,
  countComments,
  getIssue,
  issueCounts,
  labelsFor,
  labelsForIssues,
  listComments,
  listIssues,
  listLabels,
  pageLimit,
  type Label,
} from "../core/issues.ts";
import { getPull, pullDiff, pullDir } from "../core/pulls.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import { listReviews } from "../core/reviews.ts";
import type { User } from "../core/users.ts";
import { diffCommit, type Diff } from "../git/diff.ts";
import { isSafeRef, isSafeTreePath } from "../git/guard.ts";
import {
  blobForRender,
  blobHead,
  commitLog,
  listRefs,
  listTree,
  type TreeEntry,
  listPaths,
  type PathListing,
} from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import type { Page } from "../origins/types.ts";
import { HEAD_BYTES, RENDER_CAP } from "../web/render/kinds.ts";
import type {
  Blob,
  Branch,
  Commit,
  CommentView,
  IssueDetail,
  IssueQuery,
  IssueSummary,
  PullFacts,
  RepoFacts,
  RepoSource,
  SourceError,
  Tag,
} from "./source.ts";

/** The same ceiling the contents route uses; a page is a page. */
const MAX_BLOB_BYTES = 5_000_000;
/** A sliced G-code file is read whole, up to the cap its renderer draws. */
const blobCeiling = (path: string): number => (/\.(gcode|gco)$/i.test(path) ? RENDER_CAP.gcode : MAX_BLOB_BYTES);
const COMMIT_PAGE = 50;

export function localSource(
  app: App,
  repo: Repo,
  actor?: User | undefined,
): RepoSource {
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);

  const facts = async (): Promise<Result<RepoFacts, SourceError>> => {
    const tip = await commitLog(dir, repo.defaultBranch, { limit: 1 });
    return ok({
      owner: repo.ownerName,
      name: repo.name,
      description: repo.description,
      visibility: repo.visibility,
      defaultBranch: repo.defaultBranch,
      openIssues: issueCounts(app.db, repo.id, "issue").open,
      openPulls: issueCounts(app.db, repo.id, "pull").open,
      pushedAt: tip.ok ? (tip.value[0]?.date ?? null) : null,
      htmlUrl: repo.origin?.htmlUrl ?? null,
      permissions: {
        push: actor !== undefined && canWrite(app.db, repo, actor),
      },
    });
  };

  interface IssueLike {
    number: number;
    kind: "issue" | "pull";
    title: string;
    state: "open" | "closed";
    authorName: string;
    originAuthor: string | null;
    originUrl: string | null;
    createdAt: string;
    updatedAt: string;
    closedAt: string | null;
    closeReason?: string | null;
    id: string;
  }

  /**
   * The row shape, given its labels and comment count. Split out from
   * `summaryOf` so a *page* of rows can be built from two queries instead of
   * two per row — the same answers, asked once.
   */
  const rowOf = (
    issue: IssueLike,
    labels: Label[],
    commentCount: number,
  ): IssueSummary => ({
    number: issue.number,
    kind: issue.kind,
    title: issue.title,
    state: issue.state,
    authorName: issue.authorName,
    originAuthor: issue.originAuthor,
    originUrl: issue.originUrl,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
    ...(issue.closeReason === "parked" ? { parked: true } : {}),
    labels,
    commentCount,
  });

  /** One row on its own — the detail page, where there is nothing to group. */
  const summaryOf = (issue: IssueLike): IssueSummary =>
    rowOf(
      issue,
      labelsFor(app.db, issue.id),
      // A count, not `listComments(...).length`: the old spelling read every
      // comment body off disk, joined each author, and then discarded all of
      // it to arrive at an integer.
      countComments(app.db, issue.id),
    );

  /** A whole page of rows, in two queries. */
  const summariesOf = (issues: IssueLike[]): IssueSummary[] => {
    const ids = issues.map((issue) => issue.id);
    const labels = labelsForIssues(app.db, ids);
    const counts = commentCounts(app.db, ids);
    return issues.map((issue) =>
      rowOf(issue, labels.get(issue.id) ?? [], counts.get(issue.id) ?? 0),
    );
  };

  return {
    where: { kind: "local", repo },
    capabilities: {
      write: actor !== undefined && canWrite(app.db, repo, actor),
      mirror: false,
      pin: actor !== undefined,
    },

    describe: facts,

    async branches(): Promise<Result<Branch[], SourceError>> {
      const refs = await listRefs(dir, "refs/heads/");
      if (!refs.ok) return ok([]);
      return ok(
        refs.value.map((r) => ({
          name: r.name.replace("refs/heads/", ""),
          oid: r.oid,
          isDefault: r.name === `refs/heads/${repo.defaultBranch}`,
        })),
      );
    },

    async tags(): Promise<Result<Tag[], SourceError>> {
      const refs = await listRefs(dir, "refs/tags/");
      if (!refs.ok) return ok([]);
      return ok(
        refs.value.map((r) => ({
          name: r.name.replace("refs/tags/", ""),
          oid: r.oid,
          commit: r.peeled ?? r.oid,
        })),
      );
    },

    async tree(
      ref: string,
      path: string,
    ): Promise<Result<TreeEntry[], SourceError>> {
      if (!isSafeRef(ref) || (path !== "" && !isSafeTreePath(path)))
        return err("not_found");
      const entries = await listTree(dir, ref, path);
      return entries.ok ? ok(entries.value) : err("not_found");
    },

    async paths(ref: string): Promise<Result<PathListing, SourceError>> {
      if (!isSafeRef(ref)) return err("not_found");
      const listed = await listPaths(dir, ref);
      return listed.ok ? ok(listed.value) : err("not_found");
    },

    async blob(ref: string, path: string): Promise<Result<Blob, SourceError>> {
      if (!isSafeRef(ref) || !isSafeTreePath(path)) return err("not_found");
      const blob = await blobForRender(dir, ref, path, blobCeiling(path));
      if (blob.kind === "missing") return err("not_found");
      if (blob.kind !== "too_large") return ok(blob);
      // Too large to read, but its first bytes still say what it is.
      const head = await blobHead(dir, ref, path, HEAD_BYTES);
      return ok(head === undefined ? blob : { ...blob, head });
    },

    async readme(ref) {
      if (!isSafeRef(ref)) return err("not_found");
      const entries = await listTree(dir, ref, "");
      if (!entries.ok) return err("not_found");
      const found = readmeIn(entries.value);
      if (found === undefined) return ok(null);
      const blob = await blobForRender(dir, ref, found, MAX_BLOB_BYTES);
      if (blob.kind !== "text") return ok(null);
      return ok({
        path: found,
        markdown: new TextDecoder().decode(blob.body),
      });
    },

    async commits(
      ref: string,
      cursor?: string,
    ): Promise<Result<Page<Commit>, SourceError>> {
      if (!isSafeRef(ref)) return err("not_found");
      const skip = Number(cursor);
      const from = Number.isInteger(skip) && skip > 0 ? skip : 0;
      const log = await commitLog(dir, ref, { limit: COMMIT_PAGE, skip: from });
      if (!log.ok) return err("not_found");
      return ok({
        items: log.value,
        next:
          log.value.length >= COMMIT_PAGE ? String(from + COMMIT_PAGE) : null,
      });
    },

    async commit(
      oid: string,
    ): Promise<Result<{ commit: Commit; diff: Diff }, SourceError>> {
      if (!isSafeRef(oid)) return err("not_found");
      const log = await commitLog(dir, oid, { limit: 1 });
      const commit = log.ok ? log.value[0] : undefined;
      if (commit === undefined) return err("not_found");
      const diff = await diffCommit(dir, commit.oid);
      return ok({
        commit,
        diff: diff.ok ? diff.value : emptyDiff(),
      });
    },

    async issues(
      query: IssueQuery,
    ): Promise<Result<Page<IssueSummary>, SourceError>> {
      const limit = pageLimit(query.limit);
      const cursor = Number(query.cursor);
      const rows = listIssues(app.db, repo.id, {
        kind: query.kind,
        state: query.state,
        limit,
        ...sealedScope(app.db, repo, actor),
        ...(query.label === undefined ? {} : { label: query.label }),
        ...(query.author === undefined ? {} : { author: query.author }),
        ...(query.query === undefined ? {} : { query: query.query }),
        ...(Number.isInteger(cursor) && cursor > 0 ? { cursor } : {}),
      });
      const items = summariesOf(rows);
      const last = items[items.length - 1];
      return ok({
        items,
        next:
          items.length >= limit && last !== undefined
            ? String(last.number)
            : null,
      });
    },

    async issue(number: number): Promise<Result<IssueDetail, SourceError>> {
      const issue = getIssue(app.db, repo.id, number);
      if (issue === undefined || !mayView(app.db, repo, issue, actor))
        return err("not_found");
      const comments: CommentView[] = listComments(app.db, issue.id, {
        kind: "comment",
      }).map((c) => ({
        id: c.id,
        authorName: c.authorName,
        originAuthor: c.originAuthor,
        originUrl: null,
        body: c.body,
        createdAt: c.createdAt,
      }));

      let pull: PullFacts | null = null;
      if (issue.kind === "pull") {
        const row = getPull(app.db, repo.id, number);
        if (row !== undefined) {
          const { status, diff } = await pullDiff(
            await pullDir(app.db, app.reposRoot, repo, row),
            row,
          );
          pull = {
            baseBranch: row.baseBranch,
            headBranch: row.headBranch,
            baseOid: status.baseOid,
            headOid: status.headOid,
            mergedAt: row.mergedAt,
            draft: false,
            diff,
            mergeable: status.mergeable,
            conflicts: status.conflicts,
            proposal: pullProposalOf(app.db, row.id) ?? null,
            reviews: listReviews(app.db, row.id).map((review) => ({
              author: review.originAuthor ?? review.authorName,
              state: review.state,
              body: review.body,
              commitOid: review.commitOid,
              createdAt: review.createdAt,
              current: review.commitOid === status.headOid,
            })),
          };
        }
      }
      return ok({
        issue: summaryOf(issue),
        body: issue.body,
        comments,
        pull,
      });
    },

    async labels(): Promise<Result<Label[], SourceError>> {
      return ok(listLabels(app.db, repo.id));
    },
  };
}

/** README.* at the root, preferring the plainest spelling. */
function readmeIn(entries: readonly TreeEntry[]): string | undefined {
  const files = entries.filter((e) => e.type === "blob");
  const exact = files.find((e) => e.name.toLowerCase() === "readme.md");
  if (exact) return exact.name;
  const any = files.find((e) => e.name.toLowerCase().startsWith("readme"));
  return any?.name;
}

const emptyDiff = (): Diff => ({ files: [], additions: 0, deletions: 0 });
