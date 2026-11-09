/**
 * Which rows a fleet operation is about: a query line in, row ids out.
 *
 * The line is a kind and then `field:value` terms, all of which must hold:
 * `repo autonomy:autonomous`, `run state:queued repo:!trevato/forge`,
 * `issue repo:engine label:bug assignee:none`. A value starting with `!`
 * negates the term. This is the small grammar operations need to name their
 * rows; the fleet table (#446) grows the language, and this module is the
 * one seam it replaces.
 *
 * Only rows the viewer may read are ever selected — a repository you cannot
 * see is not refused, it is absent, the same ambiguity `not_found` keeps.
 *
 * `limb:<number>` on issues selects a limb (`core/milestones.ts`): the
 * issue of that number and everything beneath it that only it needs, top
 * down — never what other work outside the limb also waits for. It needs
 * the repository named, since a number means nothing without one.
 * `limb:<number>^` is the same rows, leaves first: the order in which a
 * limb comes back from behind the Later gate.
 */

import type { Database } from "bun:sqlite";
import { readPlan } from "../core/milestones.ts";
import { canRead, getRepo } from "../core/repos.ts";
import { REPO_VISIBLE } from "../core/visibility.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type FleetKind = "repo" | "run" | "issue";

/** More rows than this and the operator must narrow the query. */
export const MAX_ROWS = 500;
const MAX_QUERY = 500;
const MAX_TERMS = 20;

export interface Term {
  readonly field: string;
  readonly value: string;
  readonly negate: boolean;
}

export interface FleetQuery {
  readonly kind: FleetKind;
  readonly terms: readonly Term[];
}

export type QueryError =
  | { code: "bad_query"; message: string }
  | { code: "too_many"; message: string };

const KINDS: Record<string, FleetKind> = {
  repo: "repo",
  repos: "repo",
  run: "run",
  runs: "run",
  issue: "issue",
  issues: "issue",
};

/**
 * Each field as a SQL predicate over one bound value. The FROM clause of
 * every kind joins `repo` and its owner as `user`, so the repository
 * fields mean the same thing on every kind.
 */
type Predicate = (p: string) => string;

const repoFields: Record<string, Predicate> = {
  owner: (p) => `user.username = ${p} COLLATE NOCASE`,
  name: (p) => `repo.name = ${p} COLLATE NOCASE`,
};

const FIELDS: Record<FleetKind, Record<string, Predicate>> = {
  repo: {
    ...repoFields,
    id: (p) => `repo.id = ${p}`,
    autonomy: (p) => `repo.autonomy = ${p} COLLATE NOCASE`,
    visibility: (p) => `repo.visibility = ${p} COLLATE NOCASE`,
  },
  run: {
    ...repoFields,
    id: (p) => `run.id = ${p}`,
    state: (p) => `run.state = ${p} COLLATE NOCASE`,
    kind: (p) => `run.kind = ${p} COLLATE NOCASE`,
    agent: (p) =>
      `run.actor_id IN (SELECT id FROM user AS a WHERE a.username = ${p} COLLATE NOCASE)`,
    issue: (p) =>
      `run.issue_id IN (SELECT i.id FROM issue AS i
         WHERE i.repo_id = run.repo_id AND i.number = CAST(${p} AS INTEGER))`,
  },
  issue: {
    ...repoFields,
    id: (p) => `issue.id = ${p}`,
    number: (p) => `issue.number = CAST(${p} AS INTEGER)`,
    state: (p) => `issue.state = ${p} COLLATE NOCASE`,
    assignee: (p) =>
      `(CASE WHEN ${p} = 'none' THEN issue.assignee_id IS NULL
        ELSE issue.assignee_id IN (SELECT id FROM user AS a WHERE a.username = ${p} COLLATE NOCASE) END)`,
    label: (p) =>
      `EXISTS (SELECT 1 FROM issue_label JOIN label ON label.id = issue_label.label_id
         WHERE issue_label.issue_id = issue.id AND label.name = ${p} COLLATE NOCASE)`,
    // A limb is read from the tree, not by one predicate: see `limbIds`.
    limb: () => "0",
  },
};

/**
 * The ids `limb:<number>` names, top down, for the repository the query
 * names — or why not. A repository the viewer cannot read has no limb.
 */
function limbIds(
  db: Database,
  viewer: User | undefined,
  query: FleetQuery,
  term: Term,
): Result<string[], QueryError> {
  const named = query.terms.filter(
    (t) => t.field === "repo" && !t.negate && t.value.includes("/"),
  );
  if (named.length !== 1)
    return bad("limb:<number> needs the repository: repo:owner/name");
  const up = term.value.endsWith("^");
  const number = Number(up ? term.value.slice(0, -1) : term.value);
  if (!Number.isInteger(number) || number < 1)
    return bad("limb takes the number of an issue");
  const [owner, name] = named[0]!.value.split("/");
  const repo = getRepo(db, owner ?? "", name ?? "");
  if (repo === undefined || !canRead(db, repo, viewer)) return ok([]);
  const ids = (readPlan(db, repo).limb(number)?.own ?? []).map((i) => i.id);
  return ok(up ? ids.reverse() : ids);
}

const FROM: Record<FleetKind, { table: string; from: string; order: string }> =
  {
    repo: {
      table: "repo",
      from: "repo JOIN user ON user.id = repo.owner_id",
      order: "user.username, repo.name",
    },
    run: {
      table: "run",
      from: `run JOIN repo ON repo.id = run.repo_id
             JOIN user ON user.id = repo.owner_id`,
      order: "run.id DESC",
    },
    issue: {
      table: "issue",
      from: `issue JOIN repo ON repo.id = issue.repo_id
             JOIN user ON user.id = repo.owner_id`,
      order: "user.username, repo.name, issue.number",
    },
  };

const bad = (message: string): Result<never, QueryError> =>
  err({ code: "bad_query", message });

/** Read a query line. Every field is checked against its kind's list. */
export function parseQuery(text: string): Result<FleetQuery, QueryError> {
  if (text.length > MAX_QUERY) return bad(`a query is at most ${MAX_QUERY} characters`);
  const [head, ...rest] = text.trim().split(/\s+/);
  const kind = KINDS[(head ?? "").toLowerCase()];
  if (kind === undefined)
    return bad("a query starts with what it selects: repo, run or issue");
  if (rest.length > MAX_TERMS) return bad(`a query has at most ${MAX_TERMS} terms`);
  const terms: Term[] = [];
  for (const word of rest) {
    const colon = word.indexOf(":");
    const field = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
    let value = colon > 0 ? word.slice(colon + 1) : "";
    const negate = value.startsWith("!");
    if (negate) value = value.slice(1);
    if (field === "" || value === "")
      return bad(`"${word}" is not field:value`);
    if (field !== "repo" && FIELDS[kind][field] === undefined)
      return bad(
        `${kind} has no field "${field}"; it has repo, ${Object.keys(FIELDS[kind]).join(", ")}`,
      );
    terms.push({ field, value, negate });
  }
  return ok({ kind, terms });
}

/**
 * The ids a query selects for `viewer` (undefined: a signed-out visitor),
 * in a stable order. More than
 * `MAX_ROWS` is refused rather than cut: an operation over the first 500
 * of 900 rows is not what anyone meant.
 */
export function selectRows(
  db: Database,
  viewer: User | undefined,
  query: FleetQuery,
): Result<string[], QueryError> {
  // Signed out, `?1` is an id no account has: only public repositories hold.
  const params: (string | number)[] = [viewer?.id ?? ""];
  const bind = (value: string): string => {
    params.push(value);
    return `?${params.length}`;
  };
  const where = [REPO_VISIBLE];
  if (query.kind === "issue") where.push("issue.kind = 'issue'");
  /** For a limb: its rows' places, top down, so the limb comes before its leaves. */
  let limbOrder: Map<string, number> | undefined;
  for (const term of query.terms) {
    let sql: string;
    if (query.kind === "issue" && term.field === "limb") {
      const ids = limbIds(db, viewer, query, term);
      if (!ids.ok) return ids;
      if (ids.value.length > MAX_ROWS)
        return err({
          code: "too_many",
          message: `more than ${MAX_ROWS} rows match; narrow the query`,
        });
      if (!term.negate)
        limbOrder = new Map(ids.value.map((id, n) => [id, n]));
      sql =
        ids.value.length === 0
          ? "0"
          : `issue.id IN (${ids.value.map((id) => bind(id)).join(",")})`;
    } else if (term.field === "repo") {
      // `owner/name`, or a bare name in any owner.
      const slash = term.value.indexOf("/");
      sql =
        slash < 0
          ? repoFields.name!(bind(term.value))
          : `${repoFields.owner!(bind(term.value.slice(0, slash)))}
             AND ${repoFields.name!(bind(term.value.slice(slash + 1)))}`;
    } else sql = FIELDS[query.kind][term.field]!(bind(term.value));
    // COALESCE: a NULL comparison negated is still NULL, and `!x` must
    // select the rows where x does not hold, including the empty ones.
    const held = `COALESCE((${sql}), 0)`;
    where.push(term.negate ? `NOT ${held}` : held);
  }
  const { table, from, order } = FROM[query.kind];
  params.push(MAX_ROWS + 1);
  const ids = db
    .query<{ id: string }, (string | number)[]>(
      `SELECT ${table}.id AS id FROM ${from}
       WHERE ${where.join(" AND ")}
       ORDER BY ${order} LIMIT ?${params.length}`,
    )
    .all(...params)
    .map((r) => r.id);
  if (ids.length > MAX_ROWS)
    return err({
      code: "too_many",
      message: `more than ${MAX_ROWS} rows match; narrow the query`,
    });
  if (limbOrder !== undefined) {
    const place = limbOrder;
    ids.sort((a, b) => (place.get(a) ?? 0) - (place.get(b) ?? 0));
  }
  return ok(ids);
}
