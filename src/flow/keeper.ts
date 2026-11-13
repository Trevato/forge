/**
 * The throughput keeper (#7645): once a minute it measures the landing rate
 * (`keeper_rate.ts`); when it is low it names the one cause binding it
 * (`keeper_cause.ts`) and acts only where the act is reversible and its own:
 * unsticking assigned issues with no run. After `EFFECT_MS` it checks whether
 * landings rose; if not it undoes the act, remembers the cause as tried and
 * asks the owner one question with one button. A cause it cannot act on is
 * filed as one issue, once. It reads the database and spends no model tokens,
 * so it still speaks when the subscription is out.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { createIssue } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import { createLog } from "../kernel/log.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { KEEPER_CAUSES, pickCause, readKeeperFacts, type KeeperCause, type KeeperMove } from "./keeper_cause.ts";
import { isLow, landedBetween, readRate, type Rate } from "./keeper_rate.ts";
import { oldestWaitingOn } from "./pile.ts";
import { during } from "../perf/jobs.ts";

const log = createLog("keeper");
const HOUR_MS = 3_600_000;
/** How long after an act landings are compared with the same span before it. */
export const EFFECT_MS = 2 * HOUR_MS;
/** A cause that did not help is left alone this long. */
export const TRIED_MS = 6 * HOUR_MS;
/** A cause filed as an issue is not filed again this long. */
export const FILE_ONCE_MS = 7 * 24 * HOUR_MS;

type Outcome = "pending" | "worked" | "undone" | "asked" | "answered" | "filed";

export interface Attempt {
  readonly id: number;
  readonly at: number;
  readonly cause: KeeperCause;
  readonly action: string;
  readonly repoId: string;
  readonly says: string;
  readonly outcome: Outcome;
  readonly checkAt: number;
}

interface AttemptRow {
  id: number;
  at: number;
  cause: string;
  action: string;
  repo_id: string;
  says: string;
  outcome: string;
  check_at: number;
}

const toAttempt = (r: AttemptRow): Attempt => ({
  id: r.id,
  at: r.at,
  cause: r.cause as KeeperCause,
  action: r.action,
  repoId: r.repo_id,
  says: r.says,
  outcome: r.outcome as Outcome,
  checkAt: r.check_at,
});

const COLS = "id, at, cause, action, repo_id, says, outcome, check_at";

export function listAttempts(db: Database, limit = 20): Attempt[] {
  return db.query<AttemptRow, [number]>(`SELECT ${COLS} FROM keeper_attempt ORDER BY id DESC LIMIT ?1`).all(limit).map(toAttempt);
}

function record(db: Database, a: Omit<Attempt, "id">): number {
  return Number(
    db
      .query("INSERT INTO keeper_attempt (at, cause, action, repo_id, says, outcome, check_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .run(a.at, a.cause, a.action, a.repoId, a.says, a.outcome, a.checkAt).lastInsertRowid,
  );
}

const setOutcome = (db: Database, id: number, outcome: Outcome): void => {
  db.query("UPDATE keeper_attempt SET outcome = ?2 WHERE id = ?1").run(id, outcome);
};

/** Causes that were undone lately, or filed within the week: not tried again. */
function skipped(db: Database, now: number): Set<KeeperCause> {
  const rows = db
    .query<{ cause: string; outcome: string }, [number, number]>(
      `SELECT cause, outcome FROM keeper_attempt
        WHERE (outcome IN ('undone','asked') AND at >= ?1) OR (outcome = 'filed' AND at >= ?2)`,
    )
    .all(now - TRIED_MS, now - FILE_ONCE_MS);
  return new Set(rows.map((r) => r.cause).filter((c): c is KeeperCause => (KEEPER_CAUSES as readonly string[]).includes(c)));
}

/** Checks every act whose time is up: landings rose and it stands, or it is undone and the owner is asked. */
function settle(app: App, now: number): void {
  const { db } = app;
  const due = db
    .query<AttemptRow, [number]>(`SELECT ${COLS} FROM keeper_attempt WHERE outcome = 'pending' AND check_at <= ?1`)
    .all(now)
    .map(toAttempt);
  for (const a of due) {
    const after = landedBetween(db, a.at, now);
    const before = landedBetween(db, a.at - (now - a.at), a.at);
    if (after > before) {
      setOutcome(db, a.id, "worked");
      continue;
    }
    setOutcome(db, a.id, "undone");
    app.bus.append({ kind: "keeper.undone", repoId: a.repoId, payload: { cause: a.cause, action: a.action } });
  }
}

/** Files one issue for a cause the keeper cannot act on, in the forge's own repository; private repositories are named in it only when that repository is private too. */
export function fileOnce(app: App, found: { cause: KeeperCause; says: string }, rate: Rate, now: number): void {
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(app.db, owner, name) : undefined;
  if (!repo) return log.warn("keeper cannot file: the forge's own repository is missing", { path: ownRepoPath() });
  const oldest = found.cause === "stale_pile" ? oldestWaitingOn(app.db, 10, repo.visibility !== "private") : [];
  const list = oldest.length === 0 ? "" : `\n\nOldest waiting, start here:\n${oldest.map((s) => `- ${s.ref} (waits on ${s.on})`).join("\n")}`;
  const made = createIssue(app.db, {
    repoId: repo.id,
    authorId: repo.ownerId,
    title: `Throughput: ${found.says}`.slice(0, 200),
    body: `The throughput keeper found this binding landings (${rate.recent.toFixed(1)} an hour against a best of ${rate.best.toFixed(1)}) and cannot act on it itself.\n\n${found.says}${list}\n\nFiles: docs/features/keeper.md`,
  });
  if (!made.ok) return;
  app.bus.append({ kind: "issue.opened", repoId: repo.id, payload: { number: made.value.number } });
  record(app.db, { at: now, cause: found.cause, action: "file", repoId: repo.id, says: `Filed #${made.value.number}`, outcome: "filed", checkAt: 0 });
}

function saveState(db: Database, cause: string, says: string, now: number): void {
  db.query(
    `INSERT INTO keeper_state (id, cause, says, at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT (id) DO UPDATE SET cause = ?1, says = ?2, at = ?3`,
  ).run(cause, says, now);
}

export interface KeeperTick {
  readonly cause: KeeperCause | null;
  readonly acted: KeeperMove | null;
}

/** One tick. `onLift` runs after a brake is lifted (a sweep of assigned issues). */
export function tickKeeper(app: App, now = new Date(), onLift: () => void = () => log.warn("keeper lifted a brake with no sweep to run")): KeeperTick {
  const { db } = app;
  const t = now.getTime();
  settle(app, t);
  const rate = readRate(db, now);
  if (!isLow(rate)) {
    saveState(db, "", "", t);
    return { cause: null, acted: null };
  }
  const found = pickCause(readKeeperFacts(app, now), skipped(db, t));
  if (!found) {
    saveState(db, "", "", t);
    return { cause: null, acted: null };
  }
  // One act at a time: an act waiting on its check is left to show its effect, and its cause stays named.
  const waiting = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM keeper_attempt WHERE outcome = 'pending'").get();
  if ((waiting?.n ?? 0) > 0) return { cause: found.cause, acted: null };
  saveState(db, found.cause, found.says, t);
  if (found.move === "unstick") {
    onLift();
    record(db, { at: t, cause: found.cause, action: found.move, repoId: found.repoId, says: found.says, outcome: "pending", checkAt: t + EFFECT_MS });
    app.bus.append({ kind: "keeper.acted", repoId: found.repoId, payload: { cause: found.cause, action: found.move, says: found.says } });
    return { cause: found.cause, acted: found.move };
  }
  if (found.move === "file") {
    fileOnce(app, found, rate, t);
    return { cause: found.cause, acted: found.move };
  }
  return { cause: found.cause, acted: null };
}

/** Ticks once a minute; a tick that throws is logged and the next one runs. Returns the stop. */
export function startKeeper(app: App, onLift: () => void, everyMs = 60_000, now: () => number = Date.now): () => void {
  const timer = setInterval(() => {
    try {
      during("keeper", () => tickKeeper(app, new Date(now()), onLift));
    } catch (error) {
      log.warn("keeper tick failed", { error: String(error) });
    }
  }, everyMs);
  return () => clearInterval(timer);
}

export interface KeeperAsk {
  readonly id: number;
  readonly question: string;
  readonly button: string;
}

export interface KeeperRead {
  /** The cause binding landings now, one sentence; null while landings are fine. */
  readonly cause: string | null;
  readonly name: KeeperCause | null;
  /** The last thing it did, one sentence; null before it did anything. */
  readonly last: string | null;
  readonly ask: KeeperAsk | null;
}

const ACTION_WORDS: Record<string, string> = {
  unstick: "unstuck assigned issues",
  file: "filed an issue",
};

const clock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** The cause with no repository named in it: what a reader who may not see every repository is told. */
const GENERIC: Record<KeeperCause, string> = {
  ceiling: "A daily ceiling is reached: builders start again at 00:00 UTC.",
  usage: "Usage is the limit: no subscription has headroom.",
  unassigned: "Ready issues wait and no builder is running.",
  empty_pillar: "Nothing is ready: no pillar has an issue a builder can start.",
  stale_reds: "Open crew pulls are red and no run is working them.",
  red_checks: "Open crew pulls have a red check.",
  stale_pile: "Open crew pulls are waiting on a builder or a reviewer.",
  capacity: "Every builder slot is busy.",
};

/**
 * What home, the pipeline and the MCP show: cheap, three small reads. Only
 * `full` (a site admin) reads the sentence that names repositories and the
 * question; anyone else reads the cause with no repository in it.
 */
export function readKeeper(db: Database, full: boolean): KeeperRead {
  const state = db.query<{ cause: string; says: string }, []>("SELECT cause, says FROM keeper_state WHERE id = 1").get();
  const acts = db
    .query<AttemptRow, []>(`SELECT ${COLS} FROM keeper_attempt WHERE outcome IN ('pending','worked','undone','filed') ORDER BY id DESC LIMIT 1`)
    .all()
    .map(toAttempt)[0];
  const asked = db.query<AttemptRow, []>(`SELECT ${COLS} FROM keeper_attempt WHERE outcome = 'asked' ORDER BY id DESC LIMIT 1`).all().map(toAttempt)[0];
  const last = acts
    ? `At ${clock(acts.at)} UTC it ${ACTION_WORDS[acts.action] ?? acts.action}${acts.outcome === "undone" ? ": landings did not rise" : acts.outcome === "worked" ? ": landings rose" : acts.outcome === "pending" ? ", checking the effect" : ""}.`
    : null;
  return {
    cause: state && state.cause !== "" ? (full ? state.says : (GENERIC[state.cause as KeeperCause] ?? "")) || null : null,
    name: state && state.cause !== "" ? (state.cause as KeeperCause) : null,
    last,
    // No act asks a question since FLOW ONLY left (#7771); a question already on the books is still answerable.
    ask: full && asked ? { id: asked.id, question: asked.says, button: "Got it" } : null,
  };
}

/** The line for a page: the cause and the last act, in one sentence run; empty when there is neither. */
export function keeperLine(read: KeeperRead): string {
  return [read.cause === null ? "" : `Binding landings: ${read.cause}`, read.last ?? ""].filter((s) => s !== "").join(" ");
}

/** The owner answers a question with its one button: the act it proposed, now for good. */
export function answerKeeper(app: App, id: number, actorId?: string): { done: boolean; message: string } {
  const row = app.db.query<AttemptRow, [number]>(`SELECT ${COLS} FROM keeper_attempt WHERE id = ?1 AND outcome = 'asked'`).get(id);
  if (!row) return { done: false, message: "That question is already answered." };
  const a = toAttempt(row);
  setOutcome(app.db, a.id, "answered");
  app.bus.append({ kind: "keeper.answered", repoId: a.repoId, ...(actorId === undefined ? {} : { actorId }), payload: { action: a.action } });
  return { done: true, message: "Done." };
}
