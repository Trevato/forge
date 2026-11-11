/**
 * The batch doctor (#7555): a merge-queue gate found one pull red. It classes
 * the red (`doctor_classify.ts`), and only a functional red of a pull alone
 * on its merge is held — out of the line, with a comment naming the exact
 * test, its file, the error line and the command to reproduce, and the pull
 * handed back to its builder. The hold is "until green": the first check
 * that passes on a new head lets it go (`actions/holds.ts` `releaseOnGreen`).
 * A hold already on the pull — a person's above all — is never overwritten.
 * Budget and infra reds are recorded and left to the queue's own re-gate.
 * It is called only on the queue's re-gate, which carries the pull alone.
 * Every act is one `maintenance_run` row; the newest `RUNS_KEPT` per
 * repository are kept.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { builderOf } from "../actions/give_back.ts";
import { addComment } from "../actions/issues.ts";
import { getHold, setHold } from "../core/holds.ts";
import { getIssueById, setAssignee } from "../core/issues.ts";
import type { Pull } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { classify, reproduce, type Diagnosis } from "./doctor_classify.ts";
import type { Red } from "./queue.ts";

export const DUTY = "batch-doctor";

/** What every doctor hold's reason begins with: how a person and `releaseOnGreen` tell it from the autonomy user's own. */
export const HOLD_PREFIX = "batch doctor:";

export const isDoctorHold = (why: string): boolean => why.startsWith(HOLD_PREFIX);

export type DoctorAction = "held" | "recheck" | "kept";

/** The most `maintenance_run` rows the doctor keeps per repository; older ones are pruned on each write. */
export const RUNS_KEPT = 200;

export interface DoctorRun {
  /** `base:head`, blank for a sealed pull. */
  readonly batch: string;
  /** The pull's number, null for a sealed pull. */
  readonly culprit: number | null;
  readonly class: string;
  readonly action: string;
  readonly probe: string;
  readonly at: string;
  /** The culprit is a sealed pull: its number, batch and probe are not told. */
  readonly sealed: boolean;
}

/** Text a pull's author controls, made safe inside a markdown span: no backtick, `@`, newline or control character. */
export function plain(text: string): string {
  return text.replace(/[`@\u0000-\u001f\u007f]+/g, " ").replace(/ {2,}/g, " ").trim();
}

function cleaned(d: Diagnosis): Diagnosis {
  return {
    ...d,
    probe: plain(d.probe),
    ...(d.test === undefined
      ? {}
      : { test: { ...d.test, name: plain(d.test.name), ...(d.test.file === undefined ? {} : { file: plain(d.test.file) }) } }),
  };
}

/** Why a held pull says it is held: one line, the test first. */
function whyLine(d: Diagnosis): string {
  const name = d.test?.name ?? "the check";
  return `${HOLD_PREFIX} ${name} fails alone`;
}

/** The comment a held pull gets: test, file, error line, command, what lifts it. */
export function holdComment(d: Diagnosis, builder: User | undefined): string {
  const lines = ["The batch doctor held this pull: it is red on its own merge with main, in a functional test."];
  if (d.test !== undefined) {
    lines.push("", `- test: \`${d.test.name}\``);
    if (d.test.file !== undefined) lines.push(`- file: \`${d.test.file}\``);
  }
  lines.push(`- error: \`${d.probe}\``);
  const cmd = reproduce(d.test);
  if (cmd !== undefined) lines.push(`- reproduce: \`${cmd}\``);
  lines.push(
    "",
    `Rebase on main and fix it, then push: the hold lifts when the new head passes its own check.${builder ? ` Back to @${builder.username}.` : ""}`,
  );
  return lines.join("\n");
}

function record(app: App, repo: Repo, pull: Pull, batch: string, d: Diagnosis, action: DoctorAction): void {
  app.db
    .query(
      `INSERT INTO maintenance_run (duty, started, finished, findings, actions, probes, outcome, repo_id, issue_id, batch, culprit, class, action, probe)
       VALUES (?1, ?2, ?2, ?3, ?4, ?5, 'ok', ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    )
    .run(
      DUTY,
      new Date().toISOString(),
      JSON.stringify([`${d.class} red on pull #${pull.number}`]),
      JSON.stringify([action]),
      JSON.stringify([d.probe]),
      repo.id,
      pull.id,
      batch,
      pull.number,
      d.class,
      action,
      d.probe,
    );
  app.db
    .query(
      `DELETE FROM maintenance_run WHERE duty = ?1 AND repo_id = ?2 AND id NOT IN
         (SELECT id FROM maintenance_run WHERE duty = ?1 AND repo_id = ?2 ORDER BY id DESC LIMIT ?3)`,
    )
    .run(DUTY, repo.id, RUNS_KEPT);
}

/**
 * A red the queue's search narrowed to one pull but found on top of pulls of
 * its candidate that landed first (`together`): red alone or only with them,
 * so no culprit is proven and nothing is held. The class, the test and the
 * members are recorded, and the re-gate that carries the pull alone decides
 * the hold (`treatRed`).
 */
export function noteRed(app: App, repo: Repo, pull: Pull, red: Red, baseOid: string, together: readonly number[]): void {
  if (together.length === 0) return;
  const members = together.map((n) => `#${n}`).join(",");
  const batch = `${baseOid.slice(0, 12)}:${pull.headOid.slice(0, 12)}+${members}`;
  // A flapping batch is red on the same head with the same members again and
  // again: one row per (pull, head, members), so it cannot push the rows that
  // record real holds out of the `RUNS_KEPT` newest.
  const seen = app.db
    .query(`SELECT 1 FROM maintenance_run WHERE duty = ?1 AND repo_id = ?2 AND culprit = ?3 AND action = 'recheck' AND batch LIKE ?4 LIMIT 1`)
    .get(DUTY, repo.id, pull.number, `%:${pull.headOid.slice(0, 12)}+${members}`);
  if (seen) return;
  record(app, repo, pull, batch, cleaned(classify(red.reason, red.tests)), "recheck");
}

/** Treat one red the queue's re-gate handed back, the pull alone on its merge. `by` acts. */
export function treatRed(app: App, repo: Repo, by: User, pull: Pull, red: Red, baseOid: string): DoctorAction {
  const batch = `${baseOid.slice(0, 12)}:${pull.headOid.slice(0, 12)}`;
  const d = cleaned(classify(red.reason, red.tests));
  let action: DoctorAction;
  if (d.class !== "functional") action = "recheck";
  else if (getHold(app.db, pull.id) !== undefined) action = "kept";
  else {
    action = "held";
    const issue = getIssueById(app.db, pull.id);
    const hold = setHold(app.db, pull.id, by.id, whyLine(d).slice(0, 200), "green");
    app.bus.append({
      kind: "pull.held",
      repoId: repo.id,
      actorId: by.id,
      payload: { number: pull.number, why: hold.why },
    });
    if (issue !== undefined) {
      const builder = builderOf(app.db, repo, issue);
      addComment(app, by, repo, issue, holdComment(d, builder));
      if (builder && setAssignee(app.db, issue.id, builder.id))
        app.bus.append({
          kind: "pull.assigned",
          repoId: repo.id,
          actorId: by.id,
          payload: { number: pull.number, assignee: builder.username, agent: true },
        });
    }
  }
  record(app, repo, pull, batch, d, action);
  return action;
}

/** What a reader is told of one run: a sealed pull's number, batch and probe are blanked. */
const RUN_COLUMNS = `CASE WHEN i.sealed = 1 THEN '' ELSE m.batch END AS batch,
       CASE WHEN i.sealed = 1 THEN NULL ELSE m.culprit END AS culprit, m.class, m.action,
       CASE WHEN i.sealed = 1 THEN '' ELSE m.probe END AS probe, m.started AS at, COALESCE(i.sealed, 0) AS sealed`;

type RunRow = Omit<DoctorRun, "sealed"> & { sealed: number };
const toRun = ({ sealed, ...r }: RunRow): DoctorRun => ({ ...r, sealed: sealed === 1 });

/** The doctor's last runs on a repository, newest first; a sealed pull is not named. */
export function doctorRuns(db: Database, repoId: string, limit = 20): DoctorRun[] {
  return db
    .query<RunRow, [string, string, number]>(
      `SELECT ${RUN_COLUMNS}
         FROM maintenance_run m LEFT JOIN issue i ON i.id = m.issue_id
        WHERE m.duty = ?1 AND m.repo_id = ?2 ORDER BY m.id DESC LIMIT ?3`,
    )
    .all(DUTY, repoId, limit)
    .map(toRun);
}

/** The doctor's newest runs across repositories, in one read: every repository for `all`, public ones otherwise. */
export function recentDoctorRuns(db: Database, all: boolean, limit: number): { repo: string; run: DoctorRun }[] {
  return db
    .query<RunRow & { repo: string }, [string, number]>(
      `SELECT ${RUN_COLUMNS}, u.username || '/' || r.name AS repo
         FROM maintenance_run m
         JOIN repo r ON r.id = m.repo_id JOIN user u ON u.id = r.owner_id
         LEFT JOIN issue i ON i.id = m.issue_id
        WHERE m.duty = ?1${all ? "" : " AND r.visibility = 'public'"}
        ORDER BY m.id DESC LIMIT ?2`,
    )
    .all(DUTY, limit)
    .map(({ repo, ...r }) => ({ repo, run: toRun(r) }));
}
