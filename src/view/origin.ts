/**
 * A repository on another forge, read live.
 *
 * This is the source behind "press enter and see the repo now": no clone, no
 * import, no rows — just the origin's API behind a cache, shaped into the
 * same values `localSource` yields so a screen cannot tell them apart. What
 * it cannot do is anything at all: `capabilities.write` is false and there
 * is no method here that writes, because the credential it spends belongs to
 * the person who connected the origin and the repository belongs to somebody
 * else entirely.
 *
 * Three things are worth knowing about the reads:
 *
 * - **Everything is cached** (`view/cache.ts`), keyed by origin, repo,
 *   method and arguments. A key naming an object id is immutable and lives
 *   ten minutes; everything else is a moving target and lives a minute. The
 *   mirror job and the sync worker `bust` a repo's keys when the truth
 *   upstream moves under them.
 * - **Filters that the forges do not offer are applied here**, to the page
 *   we fetched — a label or author filter on a live browse narrows what is
 *   on screen, not what the origin searched. Honest, and bounded.
 * - **A failure is a value.** An origin that is rate-limiting us, or that
 *   has stopped accepting our token, is an outcome a surface renders — never
 *   a throw out of a page render.
 */

import type { App } from "../app.ts";
import { getOriginRepo, type Origin } from "../core/origins.ts";
import { getRepoById, type Repo } from "../core/repos.ts";
import type { Label } from "../core/issues.ts";
import type { Diff } from "../git/diff.ts";
import type { PathListing, TreeEntry } from "../git/read.ts";

const MAX_PATH_DIRS = 2_000;
const MAX_PATHS = 50_000;
import { isSafeOid } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { providerForOrigin } from "../origins/credential.ts";
import { splitFullName } from "../origins/providers/http.ts";
import type {
  Page,
  Provider,
  ProviderFailure,
  ProviderResult,
  RemoteBranch,
  RemoteCommit,
  RemoteIssue,
  RemoteTreeEntry,
} from "../origins/types.ts";
import {
  cacheKey,
  IMMUTABLE_TTL_MS,
  LIST_TTL_MS,
  viewCache,
  type CacheScope,
} from "./cache.ts";
import type {
  Blob,
  Branch,
  CommentView,
  Commit,
  IssueDetail,
  IssueQuery,
  IssueSummary,
  PullFacts,
  RepoFacts,
  RepoSource,
  SourceError,
  Tag,
} from "./source.ts";

/** git's own binary heuristic: a NUL in the first 8 KB. */
const BINARY_SNIFF = 8000;

/**
 * Build a live source for `fullName` on `origin`. The caller has already
 * established that the actor owns the origin (`sourceFor`); what is checked
 * here is only that the name is one we are willing to put in a URL.
 */
export function originSource(
  app: App,
  origin: Origin,
  fullName: string,
): Result<RepoSource, SourceError> {
  const named = splitFullName(fullName);
  if (named === undefined) return err("not_found");
  const provider = providerForOrigin(app, origin);
  if (!provider.ok) return err("unauthorized");
  return ok(build(app, origin, fullName, named, provider.value));
}

function build(
  app: App,
  origin: Origin,
  fullName: string,
  named: { owner: string; name: string },
  provider: Provider,
): RepoSource {
  const scope: CacheScope = { originId: origin.id, fullName };
  const row = getOriginRepo(app.db, origin.id, fullName);
  const htmlUrl = row?.htmlUrl || `${origin.webUrl}/${fullName}`;
  const mirroredAs = mirrorOf(app, origin, fullName);

  /** One cached read: the cache, then the origin, then the cache again. */
  const cached = async <T>(
    key: string,
    ttlMs: number,
    load: () => Promise<ProviderResult<T>>,
    weigh: (value: T) => number = () => 0,
  ): Promise<Result<T, SourceError>> => {
    const hit = viewCache.get<T>(key);
    if (hit !== undefined) return ok(hit);
    const result = await load();
    if (!result.ok) return err(toSourceError(result.error));
    viewCache.set(key, result.value, ttlMs, weigh(result.value));
    return ok(result.value);
  };

  /** A ref that is an object id names something that cannot change. */
  const ttlFor = (ref: string): number =>
    isSafeOid(ref) ? IMMUTABLE_TTL_MS : LIST_TTL_MS;

  const labelIndex = async (): Promise<Map<string, Label>> => {
    const listed = await cached(cacheKey(scope, "labels"), LIST_TTL_MS, () =>
      provider.listLabels(fullName),
    );
    const index = new Map<string, Label>();
    if (!listed.ok) return index;
    for (const label of listed.value)
      index.set(label.name.toLowerCase(), {
        id: label.remoteId,
        name: label.name,
        color: label.color,
      });
    return index;
  };

  const summaryOf = (
    remote: RemoteIssue,
    labels: Map<string, Label>,
  ): IssueSummary => ({
    number: remote.number,
    kind: remote.pull === undefined ? "issue" : "pull",
    title: remote.title,
    state: remote.state,
    // On a live browse there is no local account to name; the origin's login
    // is both the author and the provenance, and a surface marks it as such.
    authorName: remote.author,
    originAuthor: remote.author,
    originUrl: remote.htmlUrl,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
    closedAt: remote.closedAt,
    labels: remote.labels.map(
      (name) =>
        labels.get(name.toLowerCase()) ?? { id: name, name, color: "6b7280" },
    ),
    commentCount: remote.comments,
  });

  return {
    where: {
      kind: "origin",
      origin,
      fullName,
      htmlUrl,
      ...(mirroredAs === undefined ? {} : { mirroredAs }),
    },
    capabilities: {
      write: false,
      mirror: mirroredAs === undefined,
      pin: false,
    },

    async describe(): Promise<Result<RepoFacts, SourceError>> {
      const repo = await cached(cacheKey(scope, "repo"), LIST_TTL_MS, () =>
        provider.getRepo(fullName),
      );
      if (!repo.ok) return repo;
      return ok({
        owner: repo.value.owner || named.owner,
        name: repo.value.name || named.name,
        description: repo.value.description,
        visibility: repo.value.private ? "private" : "public",
        defaultBranch: repo.value.defaultBranch,
        // Neither forge reports the two counts separately without a search
        // per kind, and a browse is not worth two more round trips.
        openIssues: null,
        openPulls: null,
        pushedAt: repo.value.pushedAt,
        htmlUrl: repo.value.htmlUrl || htmlUrl,
      });
    },

    async branches(): Promise<Result<Branch[], SourceError>> {
      const listed = await cached(
        cacheKey(scope, "branches"),
        LIST_TTL_MS,
        () => provider.listBranches(fullName),
      );
      if (!listed.ok) return listed;
      const repo = await cached(cacheKey(scope, "repo"), LIST_TTL_MS, () =>
        provider.getRepo(fullName),
      );
      const head = repo.ok ? repo.value.defaultBranch : "";
      return ok(listed.value.map((b) => toBranch(b, head)));
    },

    async tags(): Promise<Result<Tag[], SourceError>> {
      const listed = await cached(cacheKey(scope, "tags"), LIST_TTL_MS, () =>
        provider.listTags(fullName),
      );
      if (!listed.ok) return listed;
      return ok(
        listed.value.map((t) => ({
          name: t.name,
          oid: t.oid,
          commit: t.oid,
        })),
      );
    },

    async tree(
      ref: string,
      path: string,
    ): Promise<Result<TreeEntry[], SourceError>> {
      const entries = await cached(
        cacheKey(scope, "tree", ref, path),
        ttlFor(ref),
        () => provider.listTree(fullName, ref, path),
      );
      if (!entries.ok) return entries;
      return ok(entries.value.map(toTreeEntry));
    },

    async paths(ref: string): Promise<Result<PathListing, SourceError>> {
      // No provider gives a flat listing cheaply and consistently, so walk the
      // cached one-level trees breadth-first. Bounded in directories and in
      // paths; a hit on either bound reports `truncated` rather than hanging.
      const key = cacheKey(scope, "paths", ref);
      const hit = viewCache.get<PathListing>(key);
      if (hit !== undefined) return ok(hit);
      {
        const paths: string[] = [];
        const queue: string[] = [""];
        let dirs = 0;
        let truncated = false;
        while (queue.length > 0) {
          if (dirs++ >= MAX_PATH_DIRS || paths.length >= MAX_PATHS) {
            truncated = true;
            break;
          }
          const dir = queue.shift()!;
          const entries = await this.tree(ref, dir);
          if (!entries.ok) return entries;
          for (const entry of entries.value) {
            const full = dir === "" ? entry.name : `${dir}/${entry.name}`;
            if (entry.type === "tree") queue.push(full);
            else if (entry.type === "blob") paths.push(full);
          }
        }
        const listing: PathListing = { paths, truncated };
        viewCache.set(key, listing, ttlFor(ref), paths.length * 40);
        return ok(listing);
      }
    },

    async blob(ref: string, path: string): Promise<Result<Blob, SourceError>> {
      const blob = await cached(
        cacheKey(scope, "blob", ref, path),
        ttlFor(ref),
        () => provider.getBlob(fullName, ref, path),
        (value) => value.content.byteLength,
      );
      if (!blob.ok) return blob;
      return ok(
        toBlob(blob.value.content, blob.value.size, blob.value.truncated),
      );
    },

    async readme(ref) {
      const found = await cached(
        cacheKey(scope, "readme", ref),
        ttlFor(ref),
        () => provider.getReadme(fullName, ref),
        (value) => value?.content.byteLength ?? 0,
      );
      if (!found.ok) return found;
      if (found.value === null || found.value.truncated) return ok(null);
      const rendered = toBlob(
        found.value.content,
        found.value.size,
        found.value.truncated,
      );
      if (rendered.kind !== "text") return ok(null);
      return ok({
        path: found.value.path,
        markdown: new TextDecoder().decode(rendered.body),
      });
    },

    async commits(
      ref: string,
      cursor?: string,
    ): Promise<Result<Page<Commit>, SourceError>> {
      const page = await cached(
        cacheKey(scope, "commits", ref, cursor ?? ""),
        ttlFor(ref),
        () => provider.listCommits(fullName, ref, cursor),
      );
      if (!page.ok) return page;
      return ok({
        items: page.value.items.map(toCommit),
        next: page.value.next,
      });
    },

    async commit(
      oid: string,
    ): Promise<Result<{ commit: Commit; diff: Diff }, SourceError>> {
      // A commit is addressed by its own id, so both halves are immutable.
      const listed = await cached(
        cacheKey(scope, "commit", oid),
        IMMUTABLE_TTL_MS,
        () => provider.listCommits(fullName, oid),
      );
      if (!listed.ok) return listed;
      const first = listed.value.items[0];
      if (first === undefined) return err("not_found");
      const diff = await cached(
        cacheKey(scope, "commit-diff", oid),
        IMMUTABLE_TTL_MS,
        () => provider.getCommitDiff(fullName, first.oid),
      );
      if (!diff.ok) return diff;
      return ok({ commit: toCommit(first), diff: diff.value });
    },

    async issues(
      query: IssueQuery,
    ): Promise<Result<Page<IssueSummary>, SourceError>> {
      const page = await cached(
        cacheKey(scope, "issues", query.kind, query.state, query.cursor ?? ""),
        LIST_TTL_MS,
        () =>
          provider.listIssues(fullName, {
            kind: query.kind,
            state: query.state,
            ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          }),
      );
      if (!page.ok) return page;
      const labels = await labelIndex();
      // The forges' list endpoints take neither a label nor an author nor a
      // title filter in a form both agree on, so a filter narrows the page
      // in hand. A surface that offers one on a live browse must say that.
      const items = page.value.items
        .map((remote) => summaryOf(remote, labels))
        .filter((item) => matches(item, query));
      return ok({ items, next: page.value.next });
    },

    async issue(number: number): Promise<Result<IssueDetail, SourceError>> {
      if (!Number.isInteger(number) || number < 1) return err("not_found");
      const remote = await cached(
        cacheKey(scope, "issue", number),
        LIST_TTL_MS,
        () => provider.getIssue(fullName, number),
      );
      if (!remote.ok) return remote;
      const comments = await cached(
        cacheKey(scope, "comments", number),
        LIST_TTL_MS,
        () => provider.listComments(fullName, number),
      );
      const labels = await labelIndex();

      let pull: PullFacts | null = null;
      if (remote.value.pull !== undefined) {
        const facts = remote.value.pull;
        const diff = await cached(
          cacheKey(scope, "pull-diff", number, facts.headOid),
          facts.headOid === "" ? LIST_TTL_MS : IMMUTABLE_TTL_MS,
          () => provider.getPullDiff(fullName, number),
        );
        pull = {
          baseBranch: facts.baseBranch,
          headBranch: facts.headBranch,
          baseOid: facts.baseOid,
          headOid: facts.headOid,
          mergedAt: facts.mergedAt,
          draft: facts.draft,
          diff: diff.ok ? diff.value : null,
          // Mergeability is the origin's to decide, and it does not tell us
          // in a form worth rendering. Null is the honest answer.
          mergeable: null,
          conflicts: [],
        };
      }

      const views: CommentView[] = comments.ok
        ? comments.value.map((c) => ({
            id: c.remoteId,
            authorName: c.author,
            originAuthor: c.author,
            originUrl: c.htmlUrl,
            body: c.body,
            createdAt: c.createdAt,
          }))
        : [];

      return ok({
        issue: summaryOf(remote.value, labels),
        body: remote.value.body,
        comments: views,
        pull,
      });
    },

    async labels(): Promise<Result<Label[], SourceError>> {
      const listed = await cached(cacheKey(scope, "labels"), LIST_TTL_MS, () =>
        provider.listLabels(fullName),
      );
      if (!listed.ok) return listed;
      return ok(
        listed.value.map((l) => ({
          id: l.remoteId,
          name: l.name,
          color: l.color,
        })),
      );
    },
  };
}

/** The local repo mirroring this remote, when there is one. */
function mirrorOf(
  app: App,
  origin: Origin,
  fullName: string,
): Repo | undefined {
  const row = app.db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM repo WHERE origin_id = ?1 AND origin_full_name = ?2 COLLATE NOCASE")
    .get(origin.id, fullName);
  return row ? getRepoById(app.db, row.id) : undefined;
}

/**
 * A provider's refusal, in the surface's vocabulary. `forbidden` and
 * `unauthorized` are one outcome here — the credential will not do — and an
 * answer we cannot parse is a broken origin, which is `unreachable`.
 */
export function toSourceError(failure: ProviderFailure): SourceError {
  switch (failure.error) {
    case "not_found":
      return "not_found";
    case "rate_limited":
      return "rate_limited";
    case "unauthorized":
    case "forbidden":
      return "unauthorized";
    default:
      return "unreachable";
  }
}

const toBranch = (branch: RemoteBranch, head: string): Branch => ({
  name: branch.name,
  oid: branch.oid,
  isDefault: branch.name === head,
  ...(branch.protected === undefined ? {} : { protected: branch.protected }),
});

/**
 * A remote entry in git's own vocabulary — the shape `listTree` yields, so
 * a renderer written against the local source needs no second branch. A
 * submodule is a commit entry, a symlink is a blob with a symlink mode, and
 * a tree's size is -1 exactly as `ls-tree -l` reports it.
 */
function toTreeEntry(entry: RemoteTreeEntry): TreeEntry {
  const type =
    entry.kind === "tree"
      ? ("tree" as const)
      : entry.kind === "submodule"
        ? ("commit" as const)
        : ("blob" as const);
  const mode =
    entry.kind === "tree"
      ? "040000"
      : entry.kind === "submodule"
        ? "160000"
        : entry.kind === "symlink"
          ? "120000"
          : "100644";
  return {
    mode,
    type,
    oid: entry.oid,
    size: entry.kind === "tree" ? -1 : (entry.size ?? 0),
    name: entry.name,
  };
}

/** A remote commit in git's shape: subject and body split at the first blank. */
function toCommit(commit: RemoteCommit): Commit {
  const message = commit.message.replace(/\r\n/g, "\n");
  const newline = message.indexOf("\n");
  const subject = newline === -1 ? message : message.slice(0, newline);
  const body = newline === -1 ? "" : message.slice(newline + 1).trim();
  return {
    oid: commit.oid,
    parents: commit.parents,
    author: commit.author.name,
    email: commit.author.email,
    date: commit.author.date,
    subject,
    body,
    ...(commit.author.login === undefined
      ? {}
      : { login: commit.author.login }),
  };
}

function toBlob(content: Uint8Array, size: number, truncated: boolean): Blob {
  if (truncated) return { kind: "too_large", size };
  if (content.subarray(0, BINARY_SNIFF).includes(0))
    return { kind: "binary", body: content, size };
  return { kind: "text", body: content, size };
}

/** The client-side half of a filter the origin's list endpoint would not do. */
function matches(item: IssueSummary, query: IssueQuery): boolean {
  if (
    query.label !== undefined &&
    !item.labels.some(
      (l) => l.name.toLowerCase() === query.label!.toLowerCase(),
    )
  )
    return false;
  if (
    query.author !== undefined &&
    item.authorName.toLowerCase() !== query.author.toLowerCase()
  )
    return false;
  if (
    query.query !== undefined &&
    query.query.trim() !== "" &&
    !item.title.toLowerCase().includes(query.query.trim().toLowerCase())
  )
    return false;
  return true;
}
