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
 * Comparisons: a numeric field (`cost`, `number`) takes `>`, `<`, `>=` or
 * `<=` before a number — `run cost:>0.5`. A time field (`created`,
 * `updated`) takes a relative age, `30m`, `12h`, `7d`, `2w`: `created:<7d`
 * is younger than seven days, `created:>7d` older, and a bare `created:7d`
 * means within. A comma means any of: `run state:queued,running`. A term
 * that does not fit its field is refused naming the field and what it
 * wanted ("cost wants a number"), and nothing is selected. Every value
 * reaches SQL as a bound parameter, never as text in the statement.
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

export type Op = "=" | ">" | "<" | ">=" | "<=";

export interface Term {
  readonly field: string;
  /** The value as written, after `!` and the comparison. */
  readonly value: string;
  readonly negate: boolean;
  readonly op: Op;
  /** `value` split on commas: the term holds when any of them does. */
  readonly values: readonly string[];
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

/** A column compared with `op`: numbers bound as numbers, ages as instants. */
type Compared = { readonly type: "number" | "time"; readonly column: string };

const created = (table: string): Compared => ({ type: "time", column: `${table}.created_at` });

const COMPARED: Record<FleetKind, Record<string, Compared>> = {
  repo: { created: created("repo") },
  run: { cost: { type: "number", column: "run.cost_usd" }, created: created("run") },
  issue: {
    number: { type: "number", column: "issue.number" },
    created: created("issue"),
    updated: { type: "time", column: "issue.updated_at" },
  },
};

const AGE_UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
const NUMBER = /^-?\d+(\.\d+)?$/;
const AGE = /^(\d{1,6})([mhdw])$/;

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
    (t) => t.field === "repo" && !t.negate && t.values.length === 1 && t.value.includes("/"),
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
    const term = parseTerm(kind, word);
    if (!term.ok) return term;
    terms.push(term.value);
  }
  return ok({ kind, terms });
}

/** Every field a kind's query may name, for errors and for the grammar both doors show. */
export function fieldsOf(kind: FleetKind): string[] {
  return ["repo", ...Object.keys(FIELDS[kind]), ...Object.keys(COMPARED[kind])];
}

/** The kinds a query line starts with, in the order the grammar lists them. */
export const FLEET_KINDS: readonly FleetKind[] = ["repo", "run", "issue"];

/** The grammar in one sentence, the same on the web page and the terminal screen. */
export const GRAMMAR =
  "A kind, then field:value terms that all hold; ! negates, a comma means any of, and cost, number or an age (30m, 12h, 7d, 2w) can be more or less with > or <.";

/** Two lines that show the grammar at work. */
export const GRAMMAR_EXAMPLES: readonly string[] = [
  "run state:queued,running cost:>0.5",
  "issue created:<7d assignee:none",
];

/** One `field:[!][op]value[,value…]` word, checked against what its field takes. */
function parseTerm(kind: FleetKind, word: string): Result<Term, QueryError> {
  const colon = word.indexOf(":");
  const field = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
  let value = colon > 0 ? word.slice(colon + 1) : "";
  const negate = value.startsWith("!");
  if (negate) value = value.slice(1);
  const op = (/^[<>]=?/.exec(value)?.[0] ?? "=") as Op;
  value = value.slice(op === "=" ? 0 : op.length);
  if (field === "" || value === "") return bad(`"${word}" is not field:value`);
  const compared = COMPARED[kind][field];
  if (field !== "repo" && FIELDS[kind][field] === undefined && compared === undefined)
    return bad(
      `${kind} has no field "${field}"; it has ${fieldsOf(kind).join(", ")}`,
    );
  const values = value.split(",");
  if (values.some((v) => v === "")) return bad(`${field} has an empty value in "${value}"`);
  if (compared === undefined) {
    if (op !== "=") return bad(`${field} takes no comparison; only a value or values`);
    if (field === "limb" && values.length > 1) return bad("limb takes the number of one issue");
  } else {
    if (op !== "=" && values.length > 1) return bad(`${field} compares with one value, not a list`);
    if (compared.type === "number" && !values.every((v) => NUMBER.test(v)))
      return bad(`${field} wants a number`);
    if (compared.type === "time" && !values.every((v) => AGE.test(v)))
      return bad(`${field} wants an age like 30m, 12h, 7d or 2w`);
  }
  return ok({ field, value, negate, op, values });
}

/** `created:<7d` is younger than 7 days: a later instant, so the comparison flips. */
const FLIP: Record<Op, Op> = { "=": ">=", "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

function comparedSql(
  compared: Compared,
  op: Op,
  value: string,
  bind: (value: string | number) => string,
): string {
  if (compared.type === "number")
    return `${compared.column} ${op} ${bind(Number(value))}`;
  const [, n, unit] = AGE.exec(value)!;
  const at = new Date(Date.now() - Number(n) * AGE_UNITS[unit!]!).toISOString();
  return `${compared.column} ${FLIP[op]} ${bind(at)}`;
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
  const bind = (value: string | number): string => {
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
    } else {
      const compared = COMPARED[query.kind][term.field];
      const one = (value: string): string => {
        if (compared !== undefined) return comparedSql(compared, term.op, value, bind);
        if (term.field !== "repo") return FIELDS[query.kind][term.field]!(bind(value));
        // `owner/name`, or a bare name in any owner.
        const slash = value.indexOf("/");
        return slash < 0
          ? repoFields.name!(bind(value))
          : `${repoFields.owner!(bind(value.slice(0, slash)))}
             AND ${repoFields.name!(bind(value.slice(slash + 1)))}`;
      };
      sql = term.values.map((v) => `(${one(v)})`).join(" OR ");
    }
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
