/**
 * Fleet operations: one action over every row a query selects. A dry run
 * answers with the plan — each row, its value before and after, and the
 * rows refused with the reason. Applying plans again from scratch (the
 * world may have moved since the preview), writes each row through the
 * platform's own action, and keeps the receipt: an `operation` row, a
 * result per row, and one `fleet.operated` event. A reversible operation
 * can be undone once, as a new operation that writes each row's value
 * from before — only where the row still holds what this one left.
 *
 * Who may: every row is the actor's to change only if they administer its
 * repository; the rest are listed as refused, never silently dropped. A
 * row the actor cannot read is not selected at all. An agent may preview
 * but never apply: a mass change is a person's call.
 */

import type { App } from "../app.ts";
import {
  claimUndo,
  getOperation,
  listOperations,
  recordOperation,
  releaseUndo,
  settleUndo,
  type FleetValue,
  type Operation,
  type OperationRow,
} from "../core/fleet_ops.ts";
import { blockerNumbersFor } from "../core/dependencies.ts";
import {
  getIssuesByIds,
  labelsForIssues,
  listLabels,
} from "../core/issues.ts";
import { listCrewRoles } from "../core/agents.ts";
import { joinMany } from "../core/pulls.ts";
import { seating, type Seating } from "../core/limb_seats.ts";
import { pillarsOf, type Pillars } from "../core/pillars.ts";
import {
  canAdmin,
  canRead,
  canSeeOwnerFacts,
  getReposByIds,
  type Repo,
} from "../core/repos.ts";
import { latestRunsForIssues } from "../core/runs.ts";
import { isStalePull } from "../crew/stale_asks.ts";
import { askDismissedBy } from "../web/studio/asks.ts";
import { mutedRepos } from "../core/interactions.ts";
import { getRunsByIds } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import {
  MAX_ROWS,
  parseQuery,
  selectRows,
  type FleetKind,
} from "../fleet/selection.ts";
import { digestOf } from "../fleet/digest.ts";
import { VERBS, type Target, type Verb } from "../fleet/verbs.ts";
import { ALREADY_UNDONE, NO_SUCH_OPERATION } from "./asks_words.ts";

export interface FleetError {
  readonly code:
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "bad_query"
    | "too_many"
    | "expired"
    | "bad_action"
    | "not_reversible"
    | "already_undone";
  readonly message: string;
}

export type PlannedOutcome = "change" | "unchanged" | "refused";

export interface PlannedRow extends Omit<OperationRow, "outcome"> {
  readonly outcome: PlannedOutcome;
}

export interface Plan {
  readonly query: string;
  readonly kind: FleetKind;
  readonly verb: string;
  readonly value: FleetValue;
  readonly reversible: boolean;
  readonly rows: readonly PlannedRow[];
  readonly counts: Readonly<Record<PlannedOutcome, number>>;
}

const fail = (code: FleetError["code"], message: string) =>
  err<FleetError>({ code, message });

const same = (a: FleetValue, b: FleetValue): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const shown = (value: FleetValue): string =>
  value === null
    ? "nothing"
    : Array.isArray(value)
      ? `[${value.join(", ")}]`
      : String(value);

/** Read `{ verb, value }` (or a bare verb) against the query's kind. */
function parseAction(
  app: App,
  kind: FleetKind,
  raw: unknown,
): Result<{ name: string; verb: Verb; value: FleetValue }, FleetError> {
  const input =
    typeof raw === "string"
      ? { verb: raw }
      : typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)
        : {};
  const name = typeof input.verb === "string" ? input.verb : "";
  const verb = Object.hasOwn(VERBS, name) ? VERBS[name] : undefined;
  if (verb === undefined || verb.kind !== kind) {
    const verbs = Object.keys(VERBS).filter((v) => VERBS[v]!.kind === kind);
    return fail("bad_action", `a ${kind} takes ${verbs.join(", ")}`);
  }
  const value = verb.parse(app, input.value ?? null);
  if (!value.ok) return fail("bad_action", value.error);
  return ok({ name, verb, value: value.value });
}

/** Every selected row with what any verb reads, in a few grouped queries. */
function loadTargets(
  app: App,
  kind: FleetKind,
  ids: readonly string[],
  viewer?: User,
): Target[] {
  if (kind === "repo") {
    const repos = getReposByIds(app.db, ids);
    return ids.flatMap((id) => {
      const repo = repos.get(id);
      return repo ? [{ id, repo, label: repoName(repo) }] : [];
    });
  }
  if (kind === "run") {
    const runs = getRunsByIds(app.db, ids);
    const repos = getReposByIds(
      app.db,
      [...runs.values()].map((r) => r.repoId),
    );
    return ids.flatMap((id) => {
      const run = runs.get(id);
      const repo = run && repos.get(run.repoId);
      return run && repo
        ? [{ id, repo, run, label: `${repoName(repo)} ${run.kind} run ${id}` }]
        : [];
    });
  }
  const issues = getIssuesByIds(app.db, ids);
  const repos = getReposByIds(
    app.db,
    [...issues.values()].map((i) => i.repoId),
  );
  const labels = labelsForIssues(app.db, ids);
  const blockers = blockerNumbersFor(app.db, ids);
  const pulls = new Map(
    joinMany(app.db, [...issues.values()].filter((i) => i.kind === "pull")).map(
      (p) => [p.id, p],
    ),
  );
  const checks = latestRunsForIssues(app.db, [...pulls.keys()]);
  const planners = new Map<string, string | null>();
  for (const repoId of repos.keys())
    planners.set(
      repoId,
      listCrewRoles(app.db, repoId).find((c) => c.role === "planner")?.agent.user
        .username ?? null,
    );
  const repoLabels = new Map<string, string[]>();
  for (const repoId of repos.keys())
    repoLabels.set(
      repoId,
      listLabels(app.db, repoId).map((l) => l.name),
    );
  const pillars = new Map<string, Pillars>();
  for (const [repoId, repo] of repos) pillars.set(repoId, pillarsOf(app.db, repo));
  const under = umbrellasOver(app, ids, [...pillars.values()]);
  // Read on the first ask, once for a repository: only `place` wants it.
  const seatings = new Map<string, Seating>();
  const seatingOf = (repo: Repo) => () => {
    let seats = seatings.get(repo.id);
    if (seats === undefined) {
      seats = seating(app.db, repo);
      seatings.set(repo.id, seats);
    }
    return seats;
  };
  const peers: ReadonlySet<string> = new Set(ids);
  const muted = viewer === undefined ? new Set<string>() : mutedRepos(app.db, viewer.id);
  const pull = (id: string) => {
    const p = pulls.get(id);
    return p === undefined
      ? undefined
      : {
          merged: p.mergedAt !== null,
          green: checks.get(id)?.state === "ok",
          stale: isStalePull(app.db, id, p.headOid),
        };
  };
  return ids.flatMap((id) => {
    const issue = issues.get(id);
    const repo = issue && repos.get(issue.repoId);
    if (!issue || !repo) return [];
    return [
      {
        id,
        repo,
        issue,
        label: `${repoName(repo)}#${issue.number}`,
        labels: (labels.get(id) ?? [])
          .map((l) => l.name)
          .sort((a, b) => a.localeCompare(b)),
        blockers: blockers.get(id) ?? [],
        repoLabels: repoLabels.get(repo.id) ?? [],
        planner: planners.get(repo.id) ?? null,
        pillars: pillars.get(repo.id)!,
        under: under.get(id) ?? [],
        seating: seatingOf(repo),
        peers,
        ...(viewer === undefined
          ? {}
          : {
              viewerId: viewer.id,
              askDismissed: askDismissedBy(app.db, viewer.id, issue),
              muted: muted.has(repo.id),
            }),
        ...(pull(id) ?? {}),
      },
    ];
  });
}

/**
 * For each of these issues, the numbers of the umbrellas — a pillar's, or
 * Later's — that wait for it directly, ascending. One grouped read.
 */
function umbrellasOver(
  app: App,
  issueIds: readonly string[],
  sets: readonly Pillars[],
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const number = new Map<string, number>();
  for (const set of sets) {
    for (const p of set.pillars) number.set(p.umbrella.id, p.umbrella.number);
    if (set.later !== undefined) number.set(set.later.id, set.later.number);
  }
  if (number.size === 0 || issueIds.length === 0) return out;
  const umbrellas = [...number.keys()];
  const CHUNK = 400;
  for (let i = 0; i < issueIds.length; i += CHUNK) {
    const chunk = issueIds.slice(i, i + CHUNK);
    const rows = app.db
      .query<{ umbrella: string; id: string }, string[]>(
        `SELECT d.issue_id AS umbrella, d.blocked_by_id AS id
           FROM issue_dependency d
          WHERE d.blocked_by_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})
            AND d.issue_id IN (${umbrellas.map((_, n) => `?${chunk.length + n + 1}`).join(",")})`,
      )
      .all(...chunk, ...umbrellas);
    for (const row of rows)
      out.set(
        row.id,
        [...(out.get(row.id) ?? []), number.get(row.umbrella)!].sort(
          (a, b) => a - b,
        ),
      );
  }
  return out;
}

const repoName = (repo: Repo): string => `${repo.ownerName}/${repo.name}`;

/**
 * Whether `actor` may change a row of this verb, asked once per repository:
 * an admin of its repository — or, for a personal verb (`dismiss`), anyone
 * the repository's asks are for, since only their own state changes.
 */
function authorityOf(
  app: App,
  actor: User,
  verb: Verb,
): (repo: Repo) => string | undefined {
  const known = new Map<string, boolean>();
  return (repo) => {
    let yes = known.get(repo.id);
    if (yes === undefined) {
      yes = verb.personal
        ? canSeeOwnerFacts(app.db, repo, actor)
        : canAdmin(app.db, repo, actor);
      known.set(repo.id, yes);
    }
    if (yes) return undefined;
    return verb.personal
      ? `${repoName(repo)} does not ask you`
      : `you are not an admin of ${repoName(repo)}`;
  };
}

/**
 * One row's plan. `expect`, for an undo, is what the row must still hold:
 * a row someone changed since is theirs now, and is left alone.
 */
function planRow(
  app: App,
  authority: (repo: Repo) => string | undefined,
  verb: Verb,
  target: Target,
  after: (before: FleetValue) => FleetValue,
  expect?: FleetValue,
): PlannedRow {
  const before = verb.read(target);
  const row = {
    targetId: target.id,
    repoId: target.repo.id,
    label: target.label,
    before,
    after: after(before),
  };
  const refused = (reason: string): PlannedRow => ({
    ...row,
    outcome: "refused",
    reason,
  });
  const denied = authority(target.repo);
  if (denied !== undefined) return refused(denied);
  if (expect !== undefined && !same(before, expect))
    return refused(`changed since: it is ${shown(before)} now`);
  if (same(row.before, row.after))
    return { ...row, outcome: "unchanged", reason: "already so" };
  const why = verb.refuse(app, target, row.after);
  return why === undefined
    ? { ...row, outcome: "change", reason: "" }
    : refused(why);
}

function counted(rows: readonly PlannedRow[]): Plan["counts"] {
  const counts = { change: 0, unchanged: 0, refused: 0 };
  for (const row of rows) counts[row.outcome] += 1;
  return counts;
}

function makePlan(
  app: App,
  actor: User | undefined,
  query: string,
  action: unknown,
  picked: readonly string[] = [],
): Result<Plan & { verbOf: Verb; targets: Map<string, Target> }, FleetError> {
  if (!actor) return fail("unauthorized", "sign in to act on the fleet");
  const parsed = parseQuery(query);
  if (!parsed.ok) return err(parsed.error);
  const act = parseAction(app, parsed.value.kind, action);
  if (!act.ok) return act;
  const ids = selectRows(app.db, actor, parsed.value);
  if (!ids.ok) return err(ids.error);
  const rows = pickWithin(ids.value, picked);
  if (picked.length > 0 && rows.length === 0) return fail("bad_query", "None of the picked rows is in the selection any more.");
  return ok(planOver(app, actor, parsed.value.kind, rows, query.trim(), act.value));
}

/** How many rows an act reaches, in words: every matching row, or the picked ones of them. */
export const pickedWords = (total: number, picked: number): string =>
  picked === 0
    ? `All ${total} matching ${total === 1 ? "row" : "rows"}`
    : `${picked} picked of ${total}`;

/**
 * The selected ids narrowed to those picked, in the selection's order; no
 * picks means every selected row. A pick outside the selection is dropped:
 * picking narrows, it never widens what the query (and the viewer) can reach.
 */
export function pickWithin(selected: readonly string[], picked: readonly string[]): string[] {
  if (picked.length === 0) return [...selected];
  const want = new Set(picked);
  return selected.filter((id) => want.has(id));
}

/** The plan for these rows: the one place a row's before, after and refusal are decided. */
function planOver(
  app: App,
  actor: User,
  kind: FleetKind,
  ids: readonly string[],
  query: string,
  act: { name: string; verb: Verb; value: FleetValue },
): Plan & { verbOf: Verb; targets: Map<string, Target> } {
  const targets = loadTargets(app, kind, ids, actor);
  const authority = authorityOf(app, actor, act.verb);
  const { verb, value } = act;
  const rows = targets.map((t) =>
    planRow(app, authority, verb, t, (before) =>
      verb.nextFor ? verb.nextFor(t, before, value) : verb.next(before, value),
    ),
  );
  return {
    query,
    kind,
    verb: act.name,
    value,
    reversible: verb.reversible,
    rows,
    counts: counted(rows),
    verbOf: verb,
    targets: new Map(targets.map((t) => [t.id, t])),
  };
}

/**
 * The same plan, for rows named by id rather than by a query — the asks'
 * bulk actions (`actions/asks_bulk.ts`). `query` is how the receipt names
 * the selection. Only rows the actor can read are planned; the rest are
 * absent, as a query would leave them.
 */
function makeIdPlan(
  app: App,
  actor: User | undefined,
  kind: FleetKind,
  ids: readonly string[],
  query: string,
  action: unknown,
): Result<Plan & { verbOf: Verb; targets: Map<string, Target> }, FleetError> {
  if (!actor) return fail("unauthorized", "sign in to act");
  const act = parseAction(app, kind, action);
  if (!act.ok) return act;
  if (ids.length > MAX_ROWS)
    return fail("too_many", `at most ${MAX_ROWS} rows at once`);
  const readable = new Set(
    loadTargets(app, kind, ids)
      .filter((t) => canRead(app.db, t.repo, actor))
      .map((t) => t.id),
  );
  return ok(planOver(app, actor, kind, ids.filter((id) => readable.has(id)), query, act.value));
}

export function previewFleetIds(
  app: App,
  actor: User | undefined,
  kind: FleetKind,
  ids: readonly string[],
  query: string,
  action: unknown,
): Result<Plan, FleetError> {
  const plan = makeIdPlan(app, actor, kind, ids, query, action);
  if (!plan.ok) return plan;
  const { verbOf: _verb, targets: _targets, ...shape } = plan.value;
  return ok(shape);
}

export async function applyFleetIds(
  app: App,
  actor: User | undefined,
  kind: FleetKind,
  ids: readonly string[],
  query: string,
  action: unknown,
): Promise<Result<Operation, FleetError>> {
  const person = requirePerson(actor);
  if (!person.ok) return person;
  const plan = makeIdPlan(app, person.value, kind, ids, query, action);
  if (!plan.ok) return plan;
  return ok(await carryOutAndRecord(app, person.value, plan.value));
}

/** Write the plan's changes and keep the receipt, with its one event. */
async function carryOutAndRecord(
  app: App,
  actor: User,
  plan: Plan & { verbOf: Verb; targets: Map<string, Target> },
): Promise<Operation> {
  const done = await carryOut(
    app,
    actor,
    plan.verbOf,
    plan.value,
    plan.rows,
    plan.targets,
  );
  const op = recordOperation(app.db, {
    actorId: actor.id,
    query: plan.query,
    kind: plan.kind,
    verb: plan.verb,
    value: plan.value,
    reversible: plan.reversible,
    undoOf: null,
    rows: done,
  });
  announce(app, op);
  return op;
}

/** The dry run: what applying would do to each row, and nothing done. */
export function previewFleetOp(
  app: App,
  actor: User | undefined,
  query: string,
  action: unknown,
  picked: readonly string[] = [],
): Result<Plan, FleetError> {
  const plan = makePlan(app, actor, query, action, picked);
  if (!plan.ok) return plan;
  const { verbOf: _verb, targets: _targets, ...shape } = plan.value;
  return ok(shape);
}

/** Write each planned change, in order; the rows as they ended. */
async function carryOut(
  app: App,
  actor: User,
  verb: Verb,
  value: FleetValue,
  rows: readonly PlannedRow[],
  targets: Map<string, Target>,
): Promise<OperationRow[]> {
  const out: OperationRow[] = [];
  for (const row of rows) {
    const target = targets.get(row.targetId);
    if (row.outcome !== "change" || target === undefined) {
      out.push({ ...row, outcome: row.outcome === "change" ? "failed" : row.outcome });
      continue;
    }
    const why = await verb.write(app, actor, target, row.after, value);
    out.push(
      why === undefined
        ? { ...row, outcome: "ok", reason: "" }
        : { ...row, outcome: "failed", reason: why },
    );
  }
  return out;
}

function announce(app: App, op: Operation): void {
  const counts = { ok: 0, failed: 0, refused: 0, unchanged: 0 };
  for (const row of op.rows) counts[row.outcome] += 1;
  app.bus.append({
    kind: "fleet.operated",
    actorId: op.actorId,
    payload: {
      operation: op.id,
      query: op.query,
      verb: op.verb,
      undoOf: op.undoOf,
      ...counts,
    },
  });
}

function requirePerson(
  actor: User | undefined,
): Result<User, FleetError> {
  if (!actor) return fail("unauthorized", "sign in to act on the fleet");
  if (actor.kind === "agent")
    return fail("forbidden", "a fleet operation is a person's call");
  return ok(actor);
}

/** Apply: plan again, write every row that may change, keep the receipt. */
export async function applyFleetOp(
  app: App,
  actor: User | undefined,
  query: string,
  action: unknown,
): Promise<Result<Operation, FleetError>> {
  const person = requirePerson(actor);
  if (!person.ok) return person;
  const plan = makePlan(app, person.value, query, action);
  if (!plan.ok) return plan;
  return ok(await carryOutAndRecord(app, person.value, plan.value));
}

/**
 * Apply only what was previewed: plan again, and if the rows now plan
 * differently from the `digest` the preview carried, write nothing.
 */
export async function applyPreviewed(
  app: App,
  actor: User | undefined,
  query: string,
  action: unknown,
  digest: string,
  picked: readonly string[] = [],
): Promise<Result<Operation, FleetError>> {
  const person = requirePerson(actor);
  if (!person.ok) return person;
  const plan = makePlan(app, person.value, query, action, picked);
  if (!plan.ok) return plan;
  if (digestOf(plan.value.rows) !== digest)
    return fail("expired", "The rows changed since the preview. Preview again to see them.");
  return ok(await carryOutAndRecord(app, person.value, plan.value));
}

/** How long a bulk action on asks can be undone: a day. */
export const UNDO_WINDOW_MS = 86_400_000;

const ASK_VERBS: readonly string[] = ["dismiss", "mute", "ship", "close", "replan"];

/** Whether a receipt is a bulk action on asks: named one by one, "asks: n selected". */
export function isAsksOperation(op: Operation): boolean {
  return (
    op.kind === "issue" && op.query.startsWith("asks: ") && ASK_VERBS.includes(op.verb)
  );
}

/** Verbs whose undo is kept for a day only, besides the asks' bulk actions. */
const DAY_VERBS: readonly string[] = ["archive"];

/** Whether an operation's undo lapses after `UNDO_WINDOW_MS`. */
const keepsADay = (op: Operation): boolean =>
  isAsksOperation(op) || DAY_VERBS.includes(op.verb);

/**
 * Undo: every row this operation changed goes back to its value from
 * before, if it still holds the value this operation left. Once per
 * operation; the undo is an operation of its own, with its own receipt.
 */
export async function undoFleetOp(
  app: App,
  actor: User | undefined,
  operationId: string,
): Promise<Result<Operation, FleetError>> {
  const person = requirePerson(actor);
  if (!person.ok) return person;
  const found = getFleetOp(app, person.value, operationId);
  if (!found.ok) return found;
  const op = found.value;
  const verb = Object.hasOwn(VERBS, op.verb) ? VERBS[op.verb] : undefined;
  if (!op.reversible || verb === undefined)
    return fail("not_reversible", `${op.verb} cannot be undone`);
  // A personal verb changed the actor's own state, and rows named one by
  // one (the asks' bulk actions, `applyFleetIds`) were the actor's own
  // selection: nobody else undoes either, a site admin included. Only an
  // operation over a fleet query is a site admin's to reverse.
  if (
    op.actorId !== person.value.id &&
    (verb.personal || !parseQuery(op.query).ok)
  )
    return fail("not_found", NO_SUCH_OPERATION);
  // The day is the same on every door: the card, the API, MCP.
  if (keepsADay(op) && Date.now() - Date.parse(op.createdAt) > UNDO_WINDOW_MS)
    return fail("expired", "an undo is kept for a day, and this one's day is over");
  if (!claimUndo(app.db, op.id))
    return fail("already_undone", ALREADY_UNDONE);
  let undone: Operation | undefined;
  try {
    const changed = op.rows.filter((r) => r.outcome === "ok");
    const targets = loadTargets(
      app,
      op.kind,
      changed.map((r) => r.targetId),
      person.value,
    );
    const byId = new Map(targets.map((t) => [t.id, t]));
    const authority = authorityOf(app, person.value, verb);
    const rows = changed.map((r): PlannedRow => {
      const target = byId.get(r.targetId);
      if (target === undefined)
        return { ...r, before: r.after, after: r.before, outcome: "refused", reason: "it is gone" };
      return planRow(app, authority, verb, target, () => r.before, r.after);
    });
    // Written backwards — what was done last is undone first, so rows that
    // lean on each other come apart in order — and kept in the order the
    // operation listed them.
    const done = (
      await carryOut(
        app,
        person.value,
        verb,
        op.value,
        [...rows].reverse(),
        byId,
      )
    ).reverse();
    undone = recordOperation(app.db, {
      actorId: person.value.id,
      query: op.query,
      kind: op.kind,
      verb: op.verb,
      value: op.value,
      reversible: true,
      undoOf: op.id,
      rows: done,
    });
    settleUndo(app.db, op.id, undone.id);
    announce(app, undone);
    return ok(undone);
  } finally {
    if (undone === undefined) releaseUndo(app.db, op.id);
  }
}

/** A receipt, for the person who acted or a site admin; anyone else gets `not_found`. */
export function getFleetOp(
  app: App,
  actor: User | undefined,
  operationId: string,
): Result<Operation, FleetError> {
  const op = getOperation(app.db, operationId);
  if (!op || !actor || (op.actorId !== actor.id && !actor.isAdmin))
    return fail("not_found", NO_SUCH_OPERATION);
  return ok(op);
}

/** The actor's own operations, newest first, without their rows. */
export function listFleetOps(
  app: App,
  actor: User | undefined,
  limit: number,
  before?: string,
): Result<Operation[], FleetError> {
  if (!actor) return fail("unauthorized", "sign in to see your operations");
  return ok(listOperations(app.db, actor.id, limit, before));
}
