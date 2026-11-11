/**
 * Search, as an action. It mutates nothing and appends no event — but it is
 * an action rather than a read helper because it decides what an actor may
 * see across four different sources, and that decision belongs in exactly
 * one place.
 *
 * The origins half is deliberately opt-in (`live`). A palette that fired
 * three API calls to three other forges on every keystroke would spend
 * somebody's rate budget to render a dropdown; the cached rows answer
 * instantly and the live search is what a person asks for when the cache
 * did not have it.
 */

import { isActive } from "../core/users.ts";
import { canSeeSealed } from "../core/sealed.ts";
import type { App } from "../app.ts";
import { appsForRepos } from "../core/apps.ts";
import { listOrigins } from "../core/origins.ts";
import { canRead, enterableApps, listReposVisibleTo } from "../core/repos.ts";
import {
  cleanQuery,
  searchKind,
  grepRepos,
  greppable,
  searchLocalIssues,
  matchOneRepo,
  searchLocalRepos,
  searchOriginRepos,
  MAX_CODE_HITS,
  MAX_SEARCH_REPOS,
  type IssueHit,
  type RepoHit,
  type CodeHit,
  type SearchKind,
  type SearchResults,
} from "../core/search.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { providerForOrigin } from "../origins/credential.ts";

/** Default page size for each list. */
export const SEARCH_LIMIT = 20;
/** Hard ceiling on a caller-chosen limit. */
export const SEARCH_LIMIT_MAX = 100;

/**
 * The refusal an API or MCP caller gets for a `kind` or `limit` the search
 * does not accept, in one set of words; undefined when both are fine. The
 * page keeps its softer `searchNote`.
 */
export function searchRefusal(
  rawKind: string | null | undefined,
  rawLimit: string | number | null | undefined,
): { code: "invalid_kind" | "invalid_limit"; message: string } | undefined {
  if (rawKind !== null && rawKind !== undefined && rawKind !== "all" && searchKind(rawKind) === "all") {
    const asked = rawKind.length > 40 ? `${rawKind.slice(0, 39)}…` : rawKind;
    return { code: "invalid_kind", message: `kind ${JSON.stringify(asked)} is not a kind — use all, repos, issues or code` };
  }
  if (rawLimit !== null && rawLimit !== undefined) {
    const n = typeof rawLimit === "number" ? rawLimit : /^\d{1,4}$/.test(rawLimit) ? Number(rawLimit) : 0;
    if (!Number.isInteger(n) || n < 1 || n > SEARCH_LIMIT_MAX)
      return { code: "invalid_limit", message: `limit is a whole number from 1 to ${SEARCH_LIMIT_MAX}` };
  }
  return undefined;
}

/**
 * The whole live half gets this long, all origins together. A search box
 * that blocks for a slow forge is worse than one that quietly returns what
 * the other origins had.
 */
export const LIVE_BUDGET_MS = 5_000;

export interface SearchInput {
  q: string;
  /** @default "all" */
  kind?: SearchKind;
  /** @default SEARCH_LIMIT (max SEARCH_LIMIT_MAX) */
  limit?: number;
  /** Also ask each connected origin's own issue search. @default false */
  live?: boolean;
  /**
   * Grep the code when `kind` asks for it. False when a stranger's code
   * search was refused (`http/strangers.ts`): the rest still answers.
   * @default true
   */
  withCode?: boolean;
  /**
   * Keep to this one repository, which the caller has already been checked
   * to read. It is the whole scope, not a filter on a capped answer: its
   * issues and code are searched even when it is not among the first
   * `MAX_SEARCH_REPOS` visible, and origin repositories are skipped.
   */
  repo?: Repo;
  /** Start no new grep after this many ms and report `moreCode`. @default unset: grep every repository */
  codeBudgetMs?: number;
  /** Told how long each part took, once per part asked for, for Server-Timing. */
  phase?: (name: SearchPhase, ms: number) => void;
}

/** The parts a search is timed in. */
export type SearchPhase = "repos" | "issues" | "code";

/**
 * Search everything the actor can reach. Anonymous callers get the public
 * half — the same rows a signed-out repo listing shows — and no origins,
 * because an origin belongs to the person who connected it.
 */
/** Whether the repository runs an app the actor may enter (a private one is its writers'). */
function hasEnterableApp(app: App, actor: User | undefined, repo: Repo): boolean {
  const record = appsForRepos(app.db, [repo.id]).get(repo.id);
  return (
    record !== undefined &&
    enterableApps(app.db, [{ repo, app: record }], actor, { named: false }).has(record.id)
  );
}

export async function search(
  app: App,
  actor: User | undefined,
  input: SearchInput,
): Promise<SearchResults> {
  const q = cleanQuery(input.q);
  const kind = input.kind ?? "all";
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? SEARCH_LIMIT) || SEARCH_LIMIT, 1),
    SEARCH_LIMIT_MAX,
  );
  const empty: SearchResults = {
    repos: [],
    issues: [],
    code: [],
    truncated: { repos: false, issues: false, code: false },
    moreCode: false,
    codeSkipped: false,
  };
  if (q === "") return empty;

  const wants = (which: SearchKind) => kind === "all" || kind === which;

  const phase = input.phase ?? (() => {});
  // The visibility pass is the first of the repos' work, so its clock starts here.
  const reposAt = performance.now();
  // One visibility pass. Issues and code both search "the repos this actor
  // may read", so it is resolved once and shared rather than re-derived.
  const visible =
    input.repo !== undefined
      ? [input.repo]
      : wants("issues") || wants("code")
        ? listReposVisibleTo(app.db, actor, { limit: MAX_SEARCH_REPOS })
        : [];

  const repos = !wants("repos")
    ? []
    : input.repo !== undefined
      ? matchOneRepo(input.repo, q, hasEnterableApp(app, actor, input.repo))
      : [
          ...searchLocalRepos(app.db, actor, q, limit),
          ...(actor ? searchOriginRepos(app.db, actor.id, q, limit) : []),
        ];

  // Named whenever it did work: asked for, or the pass issues and code share.
  if (wants("repos") || (input.repo === undefined && visible.length > 0)) phase("repos", performance.now() - reposAt);

  const issuesAt = performance.now();
  const issues: IssueHit[] = wants("issues")
    ? searchLocalIssues(
        app.db,
        visible,
        q,
        limit,
        new Set(
          visible
            .filter((r) => canSeeSealed(app.db, r, actor))
            .map((r) => r.id),
        ),
        actor !== undefined && isActive(actor) ? actor.id : undefined,
      )
    : [];
  const localIssueCount = issues.length;

  if (wants("issues") && input.live === true && actor !== undefined) {
    issues.push(...(await liveIssues(app, actor, q, limit)));
  }
  if (wants("issues")) phase("issues", performance.now() - issuesAt);

  const codeAt = performance.now();
  const code =
    // A one-letter query greps nothing: it would match every line (#11120).
    wants("code") && input.withCode !== false && greppable(q)
      ? await grepRepos(
          app.reposRoot,
          visible,
          q,
          Math.min(limit * 5, MAX_CODE_HITS),
          input.codeBudgetMs ?? Infinity,
          // The slot is keyed on the actor the session resolved, never on input.
          { memberId: actor?.id },
        )
      : { hits: [], truncated: false, more: false, skipped: false };
  if (wants("code")) phase("code", performance.now() - codeAt);

  return {
    repos,
    issues,
    code: code.hits,
    truncated: {
      repos: repos.length >= limit,
      issues: localIssueCount >= limit,
      code: code.truncated,
    },
    moreCode: code.more,
    codeSkipped: code.skipped,
  };
}

/**
 * Every connected origin's own issue search, in parallel, inside one budget.
 * An origin that needs reauthenticating is skipped without a request — that
 * is the whole point of recording `needsReauth` — and an origin that
 * rate-limits us or times out simply contributes nothing.
 */
async function liveIssues(
  app: App,
  actor: User,
  q: string,
  limit: number,
): Promise<IssueHit[]> {
  const origins = listOrigins(app.db, actor.id).filter((o) => !o.needsReauth);
  if (origins.length === 0) return [];

  // One deadline, shared: every origin that has answered by then
  // contributes; the one still thinking contributes nothing. Racing the
  // whole set against the clock would let one hung forge erase the answers
  // the others already gave.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), LIVE_BUDGET_MS);
  });

  const asked = origins.map(async (origin): Promise<IssueHit[]> => {
    const provider = providerForOrigin(app, origin);
    if (!provider.ok) return [];
    const found = await provider.value.searchIssues(q, limit);
    if (!found.ok) return [];
    return found.value.slice(0, limit).map(
      (issue): IssueHit => ({
        source: "origin",
        originId: origin.id,
        fullName: issue.repo ?? "",
        number: issue.number,
        kind: issue.pull === undefined ? "issue" : "pull",
        title: issue.title,
        state: issue.state,
        updatedAt: issue.updatedAt,
        htmlUrl: issue.htmlUrl,
      }),
    );
  });

  try {
    const settled = await Promise.all(
      asked.map((p) =>
        Promise.race([p.catch((): IssueHit[] => []), deadline]).then((r) =>
          r === "timeout" ? [] : r,
        ),
      ),
    );
    return settled.flat();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search only `repos`, the ones a repository-scoped credential reaches, and
 * only those the actor can read. Nothing outside them is searched, so
 * nothing outside them can appear; origins are never asked.
 */
export async function searchWithin(
  app: App,
  actor: User | undefined,
  repos: readonly Repo[],
  input: SearchInput,
): Promise<SearchResults> {
  const hits = { repos: [] as RepoHit[], issues: [] as IssueHit[], code: [] as CodeHit[] };
  const truncated = { repos: false, issues: false, code: false };
  let moreCode = false;
  let codeSkipped = false;
  // One figure per part, summed over the repositories, not one per repository.
  const spent: Partial<Record<SearchPhase, number>> = {};
  const sum = (name: SearchPhase, ms: number) => {
    spent[name] = (spent[name] ?? 0) + ms;
  };
  for (const repo of repos) {
    if (!canRead(app.db, repo, actor)) continue;
    const one = await search(app, actor, { ...input, live: false, repo, phase: sum });
    hits.repos.push(...one.repos);
    hits.issues.push(...one.issues);
    hits.code.push(...one.code);
    truncated.repos ||= one.truncated.repos;
    truncated.issues ||= one.truncated.issues;
    truncated.code ||= one.truncated.code;
    moreCode ||= one.moreCode;
    codeSkipped ||= one.codeSkipped;
  }
  for (const name of ["repos", "issues", "code"] as const) {
    const ms = spent[name];
    if (ms !== undefined) input.phase?.(name, ms);
  }
  return { ...hits, truncated, moreCode, codeSkipped };
}
