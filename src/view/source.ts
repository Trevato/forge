/**
 * One repository, however you are looking at it.
 *
 * A repo screen should not know whether the bytes behind it came out of a
 * bare git directory here or off an API on another forge. That is the whole
 * of this interface: the same questions, the same shapes, two answers —
 * `localSource` reads git and the database, `originSource` reads a provider
 * through a cache. A screen renders a `RepoSource` and never branches on
 * which one it holds.
 *
 * The point of it is the flow: **browse first, mirror if you mean it.**
 * Pressing enter on a repository in the picker used to clone it, import
 * every issue, and take seconds doing it, with nothing on screen. Now enter
 * opens the repository *live* — read-only, through the origin's own API,
 * with a banner saying so — and mirroring is a separate, visible act with a
 * progress job behind it (`origins/jobs.ts`). After the mirror, the same
 * screens read the same shapes from the local source instead.
 *
 * Two rules hold the design together:
 *
 * - **Read-only means read-only.** There is no mutation on this interface at
 *   all, in either implementation. `capabilities.write` tells a surface
 *   whether to render the buttons; the absence of methods is what makes the
 *   guarantee mechanical rather than a promise.
 * - **A live browse spends the origin owner's credential**, so only that
 *   owner may open one (`sourceFor`). Every other actor gets `not_found`,
 *   because an origin somebody else connected does not exist for you
 *   (invariant 9).
 */

import type { Label } from "../core/issues.ts";
import { getOriginFor } from "../core/origins.ts";
import { canRead, getRepo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import type { App } from "../app.ts";
import type { Diff } from "../git/diff.ts";
import type {
  Commit as GitCommit,
  PathListing,
  TreeEntry,
} from "../git/read.ts";
import type { Origin, Page } from "../origins/types.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { localSource } from "./local.ts";
import { originSource } from "./origin.ts";

export type { Page } from "../origins/types.ts";
export type { Diff } from "../git/diff.ts";
export type { TreeEntry } from "../git/read.ts";
export type { Label } from "../core/issues.ts";

/**
 * Why a read did not happen. Deliberately small, and deliberately the same
 * vocabulary for both implementations — a screen that renders "the origin is
 * rate-limiting us" differently from "no such file" is the only distinction
 * worth the words. `not_found` stays ambiguous on purpose (invariant 9).
 */
export type SourceError =
  | "not_found"
  | "unreachable"
  | "rate_limited"
  | "unauthorized"
  | "too_large";

/** A commit, as git states it, plus the origin account when there is one. */
export interface Commit extends GitCommit {
  /** The login on the origin, when the commit is attributed to an account. */
  readonly login?: string;
}

/** The facts a repo header renders. */
export interface RepoFacts {
  readonly owner: string;
  readonly name: string;
  readonly description: string;
  readonly visibility: "public" | "private";
  readonly defaultBranch: string;
  /** Null when the source cannot say cheaply — never a guess. */
  readonly openIssues: number | null;
  readonly openPulls: number | null;
  readonly pushedAt: string | null;
  /** The canonical page for this repo at its origin, when it has one. */
  readonly htmlUrl: string | null;
  /**
   * What this viewer may do to the repository *itself* — locally `canWrite`,
   * live whatever the origin reports. It is the question that decides
   * between "edit here" and "contribute via a fork", and it has to come from
   * the source, because only the source knows which side answered it.
   *
   * Optional because a surface may assemble `RepoFacts` off rows it already
   * has rather than pay for a `describe()`; both implementations of
   * `describe()` always state it. It is a hint for what to render, never a
   * protection — those live in `actions/`, where they are mechanical.
   */
  readonly permissions?: { readonly push: boolean };
}

export interface Branch {
  readonly name: string;
  readonly oid: string;
  readonly isDefault: boolean;
  readonly protected?: boolean;
}

export interface Tag {
  readonly name: string;
  readonly oid: string;
  /** For an annotated tag, the commit beneath it. */
  readonly commit: string;
}

/**
 * A file, in exactly the three states `blobForRender` yields — so the local
 * source is a pass-through and the origin source has a shape to hit rather
 * than one to invent.
 */
export type Blob =
  | { readonly kind: "text"; readonly body: Uint8Array; readonly size: number }
  | {
      readonly kind: "binary";
      readonly body: Uint8Array;
      readonly size: number;
    }
  | {
      readonly kind: "too_large";
      readonly size: number;
      /**
       * Its first bytes (`HEAD_BYTES`), when the source read them: enough to
       * say what the file is, never the file.
       */
      readonly head?: Uint8Array;
    };

/** An issue or a pull, as a list row. */
export interface IssueSummary {
  readonly number: number;
  readonly kind: "issue" | "pull";
  readonly title: string;
  readonly state: "open" | "closed";
  /** The local account, or the origin login when browsing live. */
  readonly authorName: string;
  /** The login on the origin, for anything that came from one. */
  readonly originAuthor: string | null;
  readonly originUrl: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /** A pull the crew stopped for a person: closed, but not as done. */
  readonly parked?: boolean;
  readonly labels: readonly Label[];
  readonly commentCount: number;
}

export interface CommentView {
  /** Stable within one source: a row id locally, the origin's id live. */
  readonly id: string;
  readonly authorName: string;
  readonly originAuthor: string | null;
  readonly originUrl: string | null;
  readonly body: string;
  readonly createdAt: string;
}

/** One verdict on a pull, as either side reports it. */
export interface ReviewFact {
  /** The local account, or the origin login when browsing live. */
  readonly author: string;
  readonly state: "approved" | "changes_requested" | "commented";
  readonly body: string;
  /** The head the verdict was passed on; "" when nobody said. */
  readonly commitOid: string;
  readonly createdAt: string;
  /** False when the verdict was passed on an older head — dismissed. */
  readonly current: boolean;
}

/** What a pull adds to a conversation. */
export interface PullFacts {
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly mergedAt: string | null;
  readonly draft: boolean;
  /** Null when the source has no diff to show (not fetched, or too large). */
  readonly diff: Diff | null;
  /** Local only: mergeability against the live base. */
  readonly mergeable: boolean | null;
  readonly conflicts: readonly string[];
  /** Every verdict, newest last. Empty when nobody has reviewed. */
  readonly reviews: readonly ReviewFact[];
  /** The child and origin a proposal token opened this pull for, if one did. */
  readonly proposal: { readonly child: string; readonly origin: string } | null;
}

export interface IssueDetail {
  readonly issue: IssueSummary;
  readonly body: string;
  readonly comments: readonly CommentView[];
  readonly pull: PullFacts | null;
}

export interface IssueQuery {
  readonly kind: "issue" | "pull";
  readonly state: "open" | "closed" | "all";
  readonly label?: string;
  readonly author?: string;
  readonly query?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Where the bytes are coming from, and what a surface may say about it. */
export type SourceWhere =
  | { readonly kind: "local"; readonly repo: Repo }
  | {
      readonly kind: "origin";
      readonly origin: Origin;
      readonly fullName: string;
      readonly htmlUrl: string;
      /** Set when a mirror of this remote already exists here. */
      readonly mirroredAs?: Repo;
    };

/**
 * What this viewer may do with this repository. A live browse can do exactly
 * one thing that changes anything: start a mirror.
 */
export interface SourceCapabilities {
  readonly write: boolean;
  readonly mirror: boolean;
  readonly pin: boolean;
}

export interface RepoSource {
  readonly where: SourceWhere;
  readonly capabilities: SourceCapabilities;

  describe(): Promise<Result<RepoFacts, SourceError>>;
  branches(): Promise<Result<Branch[], SourceError>>;
  tags(): Promise<Result<Tag[], SourceError>>;
  /** One directory level; `path` is "" for the root. */
  tree(ref: string, path: string): Promise<Result<TreeEntry[], SourceError>>;
  /** Every file path under `ref`, flat, for a fuzzy finder. Capped and cached. */
  paths(ref: string): Promise<Result<PathListing, SourceError>>;
  blob(ref: string, path: string): Promise<Result<Blob, SourceError>>;
  readme(
    ref: string,
  ): Promise<Result<{ path: string; markdown: string } | null, SourceError>>;
  commits(
    ref: string,
    cursor?: string,
  ): Promise<Result<Page<Commit>, SourceError>>;
  commit(
    oid: string,
  ): Promise<Result<{ commit: Commit; diff: Diff }, SourceError>>;
  issues(q: IssueQuery): Promise<Result<Page<IssueSummary>, SourceError>>;
  issue(number: number): Promise<Result<IssueDetail, SourceError>>;
  labels(): Promise<Result<Label[], SourceError>>;
}

/** Which repository a caller means: one of ours, or one on an origin. */
export type SourceRef =
  | { readonly owner: string; readonly name: string }
  | { readonly originId: string; readonly fullName: string };

/**
 * Resolve a reference to the source that can answer it, and enforce access
 * while doing it — this is the only door, so there is one place to get it
 * right.
 *
 * Local: `canRead`, exactly as every page and route already asks.
 * Origin: the connecting user and nobody else, because the browse spends
 * their credential. Both refusals are `not_found`, so neither a private repo
 * nor somebody else's connected account is confirmed to exist.
 */
export function sourceFor(
  app: App,
  actor: User | undefined,
  ref: SourceRef,
): Result<RepoSource, SourceError> {
  if ("owner" in ref) {
    const repo = getRepo(app.db, ref.owner, ref.name);
    if (!repo || !canRead(app.db, repo, actor)) return err("not_found");
    return ok(localSource(app, repo, actor));
  }
  if (actor === undefined) return err("not_found");
  const origin = getOriginFor(app.db, actor.id, ref.originId);
  if (origin === undefined) return err("not_found");
  return originSource(app, origin, ref.fullName);
}
