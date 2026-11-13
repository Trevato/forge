/**
 * The sentinel (#1131): the forge hunts its own faults. It reads what the
 * forge already knows — the run table, the decision ledger, the capacity
 * settings, `sqlite_master`, the error ring — and names what is wrong with
 * the evidence quoted. Each finding is exactly one open issue; a finding
 * that is still there is a comment on its issue, and only when the evidence
 * changed. Detectors are plain data in, plain data out; `hunt` is the only
 * thing that files.
 *
 * Left to a person, on purpose: the ingress routes at the edge are not in
 * this database, a `drill:` cause is cleared by a person running
 * `scripts/drills/run.ts` against production (the vitals card still shows
 * it, and no issue is filed), and a fix is not opened as a pull by the sentinel — each
 * finding that has a mechanical fix says what it is, and a run of the crew
 * picks the issue up like any other.
 */

import { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, openIssue, setIssueState } from "../actions/issues.ts";
import { decisionsSince } from "../core/decisions.ts";
import { getAgentByName } from "../core/agents.ts";
import {
  getIssueById,
  getLabel,
  type Issue,
} from "../core/issues.ts";
import { canWrite, getRepo, type Repo } from "../core/repos.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { leaseLapsed, listRunning } from "../core/runs.ts";
import { migrations } from "../core/schema.ts";
import { getUserByName, type User } from "../core/users.ts";
import { migrate } from "../kernel/migrate.ts";
import { createLog, recentErrors, redactSecrets } from "../kernel/log.ts";
import { spans } from "../kernel/degraded_history.ts";
import { QUEUE_WAIT_MAX_MS } from "../kernel/vitals.ts";
import { STALE_AFTER_MS } from "../runs/lease.ts";
import { isOutageSummary } from "./network.ts";
import {
  assertionLines,
  mainVerdict,
  pullsFailedSince,
  pullsOwn,
  SHARED_PULLS,
  SHARED_WINDOW_MS,
  sharedRuns,
} from "../checks/shared_red.ts";
import { readRunLogTail } from "../runs/log.ts";
import { clip } from "../text/clip.ts";
import { forgeCeiling } from "../flow/ceiling.ts";
import { personSpoke } from "./person_spoke.ts";
import { closeCaughtUp, mainAhead } from "./sentinel_main_ahead.ts";
import { closeLaneMoving, laneStopped } from "./sentinel_lane.ts";
import type { FindingKind } from "../hunt/finding.ts";
import { addLabels, kindLabels } from "../hunt/label.ts";

const log = createLog("sentinel");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A hunt an hour; a signal may bring one sooner, but never within this. */
export const HUNT_EVERY_MS = HOUR_MS;
export const SIGNAL_GAP_MS = 10 * 60_000;
/** A cause degraded longer than this in its day is a finding. */
export const DEGRADED_DAY_MS = 10 * 60_000;
/** How many alike make a streak. */
export const STREAK = 3;
/** The run summaries read per repository. */
export const RUNS_READ = 20;

export interface Finding {
  /** Stable across hunts: the same fault has the same key. */
  readonly key: string;
  readonly title: string;
  /** Numbers, run ids, lines — quoted as the forge holds them. */
  readonly evidence: readonly string[];
  readonly pillar: string;
  readonly lookFor: string;
  /** How it is filed: its labels, and so its clock (#8856). */
  readonly kind: FindingKind;
  /** A budget breach: filed at once, labelled, left unassigned for a builder (#3002). */
  readonly urgent?: true;
  /** What a person or a run would do, when it is mechanical and reversible. */
  readonly fix?: string;
  /** A degraded finding: when its cause first opened. Same cause and time, same incident (#2553). */
  readonly incident?: string;
  /** A degraded finding: when its newest span opened (#10291). */
  readonly lastOpenedAt?: string;
  /** A degraded finding whose spans have all closed: when the last one did. Absent while one is open (#10291). */
  readonly endedAt?: string;
  /** The vitals cause a budget-breach or degraded finding reads. */
  readonly cause?: string;
}

const QUOTE_MAX = 200;
/**
 * Evidence is filed where others read it, and may be public: anything
 * credential-shaped, or a long unbroken token, never leaves as quoted.
 */
export const scrub = (text: string): string =>
  redactSecrets(text).replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]");
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
export const keyPart = (text: string): string =>
  text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 60);

// ---- detectors ----

let known: Set<string> | undefined;
/** The triggers the schema itself creates: a scratch database, migrated once. */
function schemaTriggers(): Set<string> {
  if (known === undefined) {
    const scratch = new Database(":memory:");
    migrate(scratch, migrations);
    known = new Set(
      scratch
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'trigger'",
        )
        .all()
        .map((r) => r.name),
    );
    scratch.close();
  }
  return known;
}

/** A trigger in the database that the schema does not know: someone's hand. */
export function strayTriggers(db: Database): Finding[] {
  const declared = schemaTriggers();
  return db
    .query<
      { name: string; tbl_name: string; sql: string | null },
      []
    >("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .filter((t) => !declared.has(t.name))
    .map((t) => ({
      key: `trigger:${keyPart(t.name)}`,
      title: `Trigger ${t.name} on ${t.tbl_name} is not in the schema`,
      evidence: [
        `sqlite_master: trigger \`${t.name}\` on table \`${t.tbl_name}\``,
        `sql: ${clip(t.sql ?? "", QUOTE_MAX)}`,
      ],
      pillar: "Trust: the database does only what the schema says",
      // Someone's hand on the database: a trigger can refuse or rewrite any write.
      kind: "security",
      lookFor: `\`SELECT name FROM sqlite_master WHERE type = 'trigger'\` lists only triggers the schema creates.`,
      fix: `Drop it at boot like \`dropLegacyNewAccountGuards\` does (\`DROP TRIGGER "${t.name}"\`), with a test that plants it and boots.`,
    }));
}

/** Work waiting while nothing runs, or the runs that hold the slots stopped breathing. */
export function heldSlots(db: Database, now: number): Finding[] {
  const out: Finding[] = [];
  const waiting = db
    .query<{ kind: string; queued: number; oldest: string }, [string]>(
      `SELECT kind, COUNT(*) AS queued, MIN(created_at) AS oldest FROM run
        WHERE state = 'queued' AND kind IN ('check', 'deploy')
          AND (not_before IS NULL OR not_before <= ?1) GROUP BY kind`,
    )
    .all(new Date(now).toISOString());
  const running = listRunning(db);
  for (const w of waiting) {
    const waited = now - new Date(w.oldest).getTime();
    if (waited <= QUEUE_WAIT_MAX_MS) continue;
    const mine = running.filter((r) => r.run.kind === w.kind);
    const lapsed = mine.filter((r) => leaseLapsed(r.run, STALE_AFTER_MS, now));
    if (mine.length > 0 && lapsed.length < mine.length) continue;
    const last = db
      .query<
        { id: string; state: string; finished_at: string },
        [string]
      >("SELECT id, state, finished_at FROM run WHERE kind = ?1 AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1")
      .get(w.kind);
    out.push({
      key: `slot:${w.kind}`,
      title: `${w.queued} ${w.kind} run${w.queued === 1 ? "" : "s"} wait with no slot being used`,
      evidence: [
        `${w.queued} queued, the oldest since ${w.oldest}`,
        mine.length === 0
          ? "running: 0 — a slot is held by something the run table says is finished"
          : `running: ${mine.length}, lease lapsed on ${lapsed.map((r) => r.run.id).join(", ")}`,
        ...(last
          ? [`last finished: run ${last.id} (${last.state}) at ${last.finished_at}`]
          : []),
      ],
      pillar: "Reliability: the gate always has a slot",
      kind: "defect",
      lookFor: `No ${w.kind} run queued for ${QUEUE_WAIT_MAX_MS / 60_000} minutes while the slots are free; a cancelled run's process is gone with it.`,
      fix: "End the process of a cancelled run on the cancel path, and free its slot.",
    });
  }
  return out;
}

/** The crew's stops and guard parks, read from the decision ledger. */
export function ledgerStreaks(db: Database, now: number): Finding[] {
  const out: Finding[] = [];
  const since = new Date(now - 7 * DAY_MS).toISOString();
  const byRepo = new Map<string, { stops: string[]; total: number; firstAt: string }>();
  for (const d of decisionsSince(db, "retry", since)) {
    const r = byRepo.get(d.repoId) ?? { stops: [], total: 0, firstAt: d.createdAt };
    r.total++;
    if (d.createdAt < r.firstAt) r.firstAt = d.createdAt;
    if (d.answer === "stop") r.stops.push(d.id);
    byRepo.set(d.repoId, r);
  }
  for (const [repoId, r] of byRepo) {
    if (r.stops.length < STREAK || r.stops.length !== r.total) continue;
    // Stopping on a genuinely red repository is right; it is a fault only
    // when a check went green after the first stop, so the stop was wrong
    // or the retry never came.
    const first = r.firstAt;
    const green = db
      .query<
        { id: string; finished_at: string },
        [string, string]
      >("SELECT id, finished_at FROM run WHERE repo_id = ?1 AND kind = 'check' AND state = 'ok' AND finished_at > ?2 ORDER BY finished_at DESC LIMIT 1")
      .get(repoId, first);
    if (green === null) continue;
    out.push({
      key: `stops:${repoId}`,
      title: `Every retry decision in ${repoSlug(db, repoId)} this week was stop`,
      evidence: [
        `${r.stops.length} of ${r.total} \`retry\` decisions answered stop since ${since}`,
        `decisions: ${r.stops.slice(0, 5).join(", ")}`,
        `a check passed after the first stop: run ${green.id} at ${green.finished_at}`,
      ],
      pillar: "Throughput: red checks end in a fix, not a stop",
      kind: "defect",
      lookFor: "A retry decision that is not stop, or a green check after a stop.",
    });
  }
  // A skip is a run the guard saved — nothing new to act on — not a run it
  // refused; only the decisions that parked work are counted.
  const parks = new Map<string, Set<string>>();
  const skips = new Map<string, number>();
  for (const d of decisionsSince(db, "guard", new Date(now - DAY_MS).toISOString())) {
    if (d.answer === "skipped") {
      skips.set(d.repoId, (skips.get(d.repoId) ?? 0) + 1);
      continue;
    }
    // A cap is one park per issue however often it was asked again.
    const set = parks.get(d.repoId) ?? new Set<string>();
    set.add(d.issueId ?? d.id);
    parks.set(d.repoId, set);
  }
  for (const [repoId, issues] of parks) {
    const n = issues.size;
    if (n < 20) continue;
    const ids = [...issues];
    const numbers = db
      .query<{ number: number }, string[]>(
        `SELECT number FROM issue WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY number LIMIT 5`,
      )
      .all(...ids)
      .map((r) => `#${r.number}`);
    const skipped = skips.get(repoId) ?? 0;
    out.push({
      key: `parks:${repoId}`,
      title: `The guard parked ${n} runs in ${repoSlug(db, repoId)} in a day`,
      evidence: [
        `${n} \`guard\` decisions that parked distinct issues since ${new Date(now - DAY_MS).toISOString()}`,
        ...(numbers.length > 0 ? [`capped issues: ${numbers.join(", ")}`] : []),
        ...(skipped > 0 ? [`${skipped} skips of a run with nothing new are not counted`] : []),
      ],
      pillar: "Throughput: the crew spends on work, not on being refused",
      kind: "defect",
      lookFor: "Fewer than 20 guard decisions a day for the repository.",
    });
  }
  return out;
}

function repoSlug(db: Database, repoId: string): string {
  const row = db
    .query<
      { slug: string },
      [string]
    >("SELECT user.username || '/' || repo.name AS slug FROM repo JOIN user ON user.id = repo.owner_id WHERE repo.id = ?1")
    .get(repoId);
  return row?.slug ?? repoId;
}

interface SummaryRow {
  id: string;
  repo_id: string;
  kind: string;
  state: string;
  summary: string;
}

let warnedUnresolved = false;

/** The last runs per repository: a check never green, or pushes that cannot land. */
export function runStreaks(db: Database): Finding[] {
  const out: Finding[] = [];
  const [ownerName = "", repoName = ""] = sentinelRepoPath().split("/");
  const ownId = getRepo(db, ownerName, repoName)?.id;
  if (ownId === undefined && !warnedUnresolved) {
    warnedUnresolved = true;
    log.warn("sentinel repository does not resolve; never-green checks are not filed", { repo: sentinelRepoPath() });
  }
  // One top-N read per repository and kind, not one window over every run:
  // the window sorted all of them, 150 ms on a production-sized table (#8848).
  const pairs = db
    .query<{ repo_id: string; kind: string }, []>(
      "SELECT r.id AS repo_id, k.kind AS kind FROM repo r CROSS JOIN (SELECT 'check' AS kind UNION ALL SELECT 'agent') k",
    )
    .all();
  const latest = db.query<SummaryRow, [string, string, number]>(
    `SELECT id, repo_id, kind, state, summary FROM run
      WHERE repo_id = ?1 AND kind = ?2 AND state IN ('ok', 'failed')
      ORDER BY created_at DESC, id DESC LIMIT ?3`,
  );
  const rows = pairs.flatMap((p) => latest.all(p.repo_id, p.kind, RUNS_READ));
  const groups = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const k = `${r.repo_id}\u0000${r.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, runs] of groups) {
    const [repoId = "", kind = ""] = k.split("\u0000");
    const failed = runs.filter((r) => r.state === "failed");
    if (kind === "check") {
      // Another repository's gate is its owner's to fix: a builder here cannot
      // read or change it. It stays on that repository's checks and the degraded list.
      if (repoId !== ownId) continue;
      if (runs.some((r) => r.state === "ok")) continue;
      const same = new Map<string, SummaryRow[]>();
      for (const r of failed)
        same.set(oneLine(r.summary), [...(same.get(oneLine(r.summary)) ?? []), r]);
      const [line, hits] = [...same.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? ["", []];
      if (hits.length < STREAK) continue;
      out.push({
        key: `gate:${repoId}`,
        title: `The check in ${repoSlug(db, repoId)} has not been green in its last ${runs.length} runs`,
        evidence: [
          `${failed.length} of the last ${runs.length} check runs failed, none passed`,
          `${hits.length} say: "${clip(line, QUOTE_MAX)}"`,
          `runs: ${hits.slice(0, 5).map((r) => r.id).join(", ")}`,
        ],
        pillar: "Trust: a green check means something",
        kind: "defect",
        lookFor: "A green check run for the repository's newest head.",
      });
    } else {
      // A decline is the run's own decision ("I pushed nothing"), not a push that failed,
      // whether or not the summary leads with it.
      // An outage the runner retried ("no changes pushed: ... EAI_AGAIN") is not a
      // push that was refused; a "push failed: ... ECONNREFUSED" still counts.
      const pushes = failed.filter(
        (r) =>
          !/\bdeclined:/i.test(r.summary) &&
          !isOutageSummary(r.summary) &&
          /\bpush|sandbox|operation not permitted/i.test(r.summary),
      );
      if (pushes.length < STREAK) continue;
      out.push({
        key: `push:${repoId}`,
        title: `Crew runs in ${repoSlug(db, repoId)} keep failing at the push or the sandbox`,
        evidence: [
          `${pushes.length} of the last ${runs.length} agent runs failed with a push or sandbox line`,
          `e.g. "${clip(pushes[0]?.summary ?? "", QUOTE_MAX)}"`,
          `runs: ${pushes.slice(0, 5).map((r) => r.id).join(", ")}`,
        ],
        pillar: "Throughput: a crew run can finish what it starts",
        kind: "defect",
        lookFor: "An agent run that pushes its branch from inside its sandbox.",
      });
    }
  }
  return out;
}

/** The same error line over and over in the pod's own log. */
export function repeatedErrors(now: number): Finding[] {
  // The sentinel's own failures are not a fault to file about itself.
  const seen = recentErrors(100, now).latest.filter((l) => l.scope !== "sentinel");
  const groups = new Map<string, typeof seen>();
  for (const line of seen) {
    const k = `${line.scope}: ${oneLine(line.message).replace(/\d+/g, "N")}`;
    groups.set(k, [...(groups.get(k) ?? []), line]);
  }
  const out: Finding[] = [];
  for (const [k, lines] of groups) {
    if (lines.length < STREAK) continue;
    out.push({
      key: `log:${keyPart(k)}`,
      title: `The log says "${clip(k, 90)}" ${lines.length} times`,
      evidence: [
        `${lines.length} ERROR lines, newest ${lines[0]?.at ?? ""}`,
        `line: ${clip(lines[0]?.message ?? "", QUOTE_MAX)}`,
      ],
      pillar: "Reliability: a quiet log",
      kind: "defect",
      lookFor: "No ERROR line of this shape in an hour.",
    });
  }
  return out;
}

/**
 * Each cause whose spans total more than ten minutes in the day ending at
 * `now`, quoting its sentence. Shorter totals stay in the history.
 */
export function degradedCauses(db: Database, now: number, forgeRepoId?: string, dataDir?: string, ceilingUsd: number | null = null): Finding[] {
  const from = now - DAY_MS;
  const byCause = new Map<
    string,
    { sentence: string; href: string; first: number; opened: number; lastOpened: number; ms: number; ended: number }
  >();
  for (const s of spans(db, from, now)) {
    if (!ownCause(s.cause, forgeRepoId)) continue;
    const start = Math.max(s.openedAt, from);
    const held = Math.min(s.closedAt ?? now, now) - start;
    const seen = byCause.get(s.cause);
    // Spans run oldest first: the first sets the open time, the last the sentence.
    byCause.set(s.cause, {
      sentence: s.sentence,
      href: s.href,
      first: seen?.first ?? start,
      opened: seen?.opened ?? s.openedAt,
      lastOpened: s.openedAt,
      ms: (seen?.ms ?? 0) + Math.max(0, held),
      // Infinity while any span is still open: the incident has not ended.
      ended: Math.max(seen?.ended ?? -Infinity, s.closedAt ?? Infinity),
    });
  }
  const out: Finding[] = [];
  for (const [cause, d] of byCause) {
    if (d.ms <= DEGRADED_DAY_MS) continue;
    const minutes = Math.round(d.ms / 60_000);
    out.push({
      key: `degraded:${keyPart(cause)}`,
      title: `${cause} was degraded ${minutes} minutes today: ${clip(d.sentence, 120)}`,
      evidence: [
        `cause: ${cause}`,
        `sentence: ${oneLine(d.sentence)}`,
        `first open: ${new Date(d.first).toISOString()}`,
        `total: ${minutes} minutes in the day`,
        `href: ${d.href}`,
        ...sharedLines(db, cause, now, forgeRepoId, dataDir),
      ],
      pillar: "P0 Trust: the forge says when it is not well, and is well again",
      kind: "defect",
      lookFor: `\`${cause}\` stays out of the degraded list for a day, or holds under ${DEGRADED_DAY_MS / 60_000} minutes.`,
      incident: new Date(d.opened).toISOString(),
      lastOpenedAt: new Date(d.lastOpened).toISOString(),
      ...(Number.isFinite(d.ended) ? { endedAt: new Date(d.ended).toISOString() } : {}),
      cause,
    });
  }
  return out;
}

/**
 * The causes that are a budget breached: the lane, a silent run, a run
 * killed twice, a red main holding its pulls' checks, a test red on many
 * pulls at once. A red main gets one fix issue (#1971), and
 * `crew/red_fix.ts` keeps other builders off its test; a shared test gets
 * one flake issue (#2266), which its vitals card links to.
 */
const BREACH_CAUSE = /^(queue:check|stuck:|budget:|red:|shared:)/;

/**
 * A red main in another repository is its owner's to fix, not the forge's
 * (#3992): the crew cannot see that repository, so no issue is filed here.
 * Its card stays in the vitals and the owner is notified (`crew/notify.ts`).
 * `forgeRepoId` unset means no repository is known and nothing is dropped.
 */
export function ownCause(cause: string, forgeRepoId: string | undefined): boolean {
  // A drill is run against production by a person (#5367): no builder can, so no issue.
  if (cause.startsWith("drill:")) return false;
  if (forgeRepoId === undefined) return true;
  if (cause.startsWith("red:")) return cause === `red:${forgeRepoId}`;
  if (cause.startsWith("shared:")) return cause.split(":")[1] === forgeRepoId;
  return true;
}

/**
 * Each budget breach that holds right now, however briefly: the crew hears
 * at once, not when the day has added up. The finding shares its key with
 * `degradedCauses`, so one cause is one issue.
 */
export function budgetBreaches(db: Database, now: number, forgeRepoId?: string, dataDir?: string, ceilingUsd: number | null = null): Finding[] {
  const out: Finding[] = [];
  for (const s of spans(db, now - DAY_MS, now)) {
    if (s.closedAt !== null || !BREACH_CAUSE.test(s.cause) || !ownCause(s.cause, forgeRepoId)) continue;
    out.push({
      key: `degraded:${keyPart(s.cause)}`,
      title: `${s.cause} is past its budget: ${clip(s.sentence, 120)}`,
      evidence: [
        `cause: ${s.cause}`,
        `sentence: ${oneLine(s.sentence)}`,
        `since: ${new Date(s.openedAt).toISOString()}`,
        `href: ${s.href}`,
        ...runLogLines(db, s.cause),
        ...sharedLines(db, s.cause, now, forgeRepoId, dataDir),
      ],
      pillar: "P0 Trust: the forge says when it is not well, and is well again",
      kind: "defect",
      lookFor: `\`${s.cause}\` is gone from the degraded list and the cause is fixed, not waited out.`,
      fix: s.cause.startsWith("red:")
        ? "Fix the failing test on main in one pull. This is the only issue for it: pulls red on the same test wait for main, and no other builder is handed it while this is open."
        : s.cause.startsWith("shared:")
          ? "Make the named test's verdict depend only on the code under test, not on the check machine's load, disk or clock, in one pull. Pulls red on it alone wait, unparked, for main's next green check."
          : "Diagnose the cause from the evidence and hand the mechanical fix to a builder as its own issue.",
      urgent: true,
      cause: s.cause,
    });
  }
  return out;
}

/** The last log lines of the run a `stuck:` or `budget:` cause names, when it names one. */
function runLogLines(db: Database, cause: string): string[] {
  const id = /^(?:stuck|budget):(.+)$/.exec(cause)?.[1];
  if (id === undefined) return [];
  const run = db
    .query<{ summary: string | null; state: string }, [string]>(
      "SELECT summary, state FROM run WHERE id = ?1",
    )
    .get(id);
  return run === null ? [] : [`run ${id}: ${run.state}${run.summary ? `, ${oneLine(run.summary)}` : ""}`];
}

/** How many log lines a shared finding reads from the end of its newest run's log: never the whole file. */
const SHARED_LOG_TAIL = 400;

/**
 * What a builder needs to reproduce a `shared:` cause (#8286): the pulls
 * and runs that failed its test, newest first, the base the newest merged,
 * the newest one's assertion lines from the tail of its log, and whether
 * main's newest check passes the test. A private repository's pulls and log
 * lines stay out of a finding filed anywhere but in that repository.
 */
function sharedLines(
  db: Database,
  cause: string,
  now: number,
  forgeRepoId: string | undefined,
  dataDir: string | undefined,
): string[] {
  if (!cause.startsWith("shared:")) return [];
  const repoId = cause.split(":")[1] ?? "";
  const repo = db
    .query<{ visibility: string }, [string]>("SELECT visibility FROM repo WHERE id = ?1")
    .get(repoId);
  if (repo === null || (repo.visibility !== "public" && repoId !== forgeRepoId)) return [];
  const found = sharedRuns(db, cause, now);
  if (found === undefined) return [];
  const [newest] = found.runs;
  const out = [
    `test: ${oneLine(found.test)}`,
    ...found.runs.map((r) => `failed: pull #${r.pull}, check run ${r.runId}`),
  ];
  if (newest !== undefined) {
    out.push(`base: ${newest.baseOid || "none recorded"} (run ${newest.runId})`);
    const quoted =
      dataDir === undefined ? [] : assertionLines(readRunLogTail(dataDir, newest.runId, SHARED_LOG_TAIL).lines, found.test);
    out.push(...quoted.map((l) => `log: ${clip(oneLine(l), QUOTE_MAX)}`));
  }
  const main = mainVerdict(db, repoId, found.test);
  out.push(
    main === undefined
      ? "main: no check of main recorded"
      : main.passes
        ? `main: passes on main's newest check, run ${main.runId} at ${main.commitOid}`
        : `main: fails on main's newest check too, run ${main.runId} at ${main.commitOid}`,
  );
  return out;
}

/** Everything the sentinel reads, in one pass. */
export function findFaults(db: Database, now = Date.now(), forgeRepoId?: string, dataDir?: string, ceilingUsd: number | null = null): Finding[] {
  const found = [
    ...mainAhead(db, now),
    ...laneStopped(db, now, ceilingUsd),
    ...budgetBreaches(db, now, forgeRepoId, dataDir),
    ...heldSlots(db, now),
    ...strayTriggers(db),
    ...ledgerStreaks(db, now),
    ...runStreaks(db),
    ...repeatedErrors(now),
    ...degradedCauses(db, now, forgeRepoId, dataDir),
  ];
  const keys = new Set<string>();
  return found
    .filter((f) => !keys.has(f.key) && keys.add(f.key))
    .map((f) => ({
    ...f,
    title: scrub(f.title),
    evidence: f.evidence.map(scrub),
  }));
}

// ---- filing ----

export interface HuntResult {
  readonly found: number;
  readonly filed: number;
  readonly commented: number;
  /** Why nothing could be filed, when the hunt had no place or no author. */
  readonly cannotFile?: string;
}

/** `filed` in a recorded hunt that had nowhere to file. */
const UNFILED = -1;

export const sentinelRepoPath = ownRepoPath;

/** Why a hunt could not file, or undefined when it can. */
export function cannotFile(
  db: Database,
  path = sentinelRepoPath(),
): string | undefined {
  const [owner = "", name = ""] = path.split("/");
  if (getRepo(db, owner, name) === undefined) return `${path} not found`;
  if (sentinelActor(db) === undefined) return "no sentinel or admin to file as";
  return undefined;
}

function sentinelActor(db: Database): User | undefined {
  if (getAgentByName(db, "sentinel") !== undefined)
    return getUserByName(db, "sentinel");
  const admin = db
    .query<{ username: string }, []>(
      "SELECT username FROM user WHERE is_admin = 1 ORDER BY created_at LIMIT 1",
    )
    .get();
  return admin === null ? undefined : getUserByName(db, admin.username);
}

const bodyOf = (f: Finding, now: string): string =>
  [
    f.title,
    "",
    "**Evidence**",
    ...f.evidence.map((e) => `- ${e}`),
    "",
    `**Pillar:** ${f.pillar}`,
    "",
    `**What to look for when fixed:** ${f.lookFor}`,
    ...(f.fix === undefined ? [] : ["", `**Mechanical fix:** ${f.fix}`]),
    "",
    `Found by the sentinel at ${now}.`,
  ].join("\n");

/**
 * Every finding is filed sorted (#8856): its kind's labels (`bug`, with
 * `high` for a security hole), through `hunt/label.ts`, so the bug clock runs
 * from the moment it is filed. A breach is crew work at once: the P0 Trust label as
 * well, and no assignee, so a builder may start it on the next tick (#3002).
 * The sentinel never builds, so it never assigns itself: a finding parked on
 * it is held from every builder. Labels already on the issue stay. The
 * labelling may fail alone: the issue is filed either way, and the failure is said.
 */
function labelFinding(app: App, repo: Repo, actor: User, issue: Issue, f: Finding): void {
  try {
    const wanted = kindLabels(app, repo.id, f.kind);
    if (f.urgent) {
      const label = getLabel(app.db, repo.id, "P0 Trust");
      if (label === undefined) log.warn("sentinel has no P0 Trust label to apply", { issue: issue.number });
      else wanted.push(label);
    }
    addLabels(app, repo.id, actor.id, issue, wanted);
  } catch (error) {
    log.error("sentinel could not label", { issue: issue.number, error: String(error) });
  }
}

/**
 * A degraded incident whose issue was closed as done or split and which goes
 * on (same cause, same first-open time) is told to that issue, not filed
 * again: the fix is likely merged but not live. At most one comment a day.
 * One closed as dropped stays silent. True when
 * the incident is that one: the comments made (0 or 1), else undefined.
 *
 * The day's window clips an incident's early spans as it slides, which moves
 * its first-open time; a finding whose newest span had opened by the time the
 * sentinel last saw the closed issue's is still that incident. Ended, it is
 * said nothing: it was filed, fixed and over (#10167, #10237, #10291 were one).
 */
function continuesDone(app: App, repo: Repo, actor: User, f: Finding, evidence: string, at: string, now: number): 0 | 1 | undefined {
  const prior = app.db
    .query<{ issue_id: string; commented_at: string | null; same: number }, [string, string, string]>(
      `SELECT t.issue_id, t.commented_at, t.incident IS ?2 AS same FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = ?1 AND i.state = 'closed' AND (t.incident = ?2 OR t.last_seen >= ?3)
        ORDER BY same DESC, t.first_seen DESC LIMIT 1`,
    )
    .get(f.key, f.incident ?? "", f.lastOpenedAt ?? "\uffff");
  if (prior === null) return undefined;
  const issue = getIssueById(app.db, prior.issue_id);
  if (issue === undefined) return undefined;
  if (issue.closeReason === "dropped") return 0;
  if (issue.closeReason !== "done" && issue.closeReason !== "split") return undefined;
  if (prior.same === 0 && f.endedAt !== undefined) return 0;
  if (prior.commented_at !== null && now - Date.parse(prior.commented_at) < DAY_MS) return 0;
  const minutes = f.evidence.find((e) => e.startsWith("total: "));
  const said = addComment(
    app,
    actor,
    repo,
    issue,
    `Still degraded${issue.closeReason === "split" ? "; the work was split into other issues" : " after the fix; the fix may not be live yet"}. At ${at}${minutes === undefined ? "" : `, ${minutes.slice(7)}`}; evidence now:\n${f.evidence.map((e) => `- ${e}`).join("\n")}`,
  );
  if (!said.ok) {
    log.warn("sentinel could not comment", { key: f.key, error: String(said.error) });
    return 0;
  }
  app.db
    .query("UPDATE sentinel_finding SET commented_at = ?1, last_seen = ?1, evidence = ?2 WHERE key = ?3 AND issue_id = ?4")
    .run(at, evidence, f.key, prior.issue_id);
  return 1;
}

interface RecentFix {
  readonly issueId: string;
  readonly closedAt: number;
  /** Its issue was already told the test is still red since that close. */
  readonly told: boolean;
}

/**
 * A shared test's issue closed as done or split within the hour (#8185): its
 * close is the landing on main, since a merged pull closes what it fixes only
 * once it lands. The hour's window still holds the reds from before it.
 */
function recentFix(db: Database, f: Finding, now: number): RecentFix | undefined {
  if (f.cause?.startsWith("shared:") !== true) return undefined;
  const prior = db
    .query<{ issue_id: string; commented_at: string | null; closed_at: string | null }, [string]>(
      `SELECT t.issue_id, t.commented_at, i.closed_at FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = ?1 AND i.state = 'closed' AND i.parked = 0 AND i.close_reason IN ('done', 'split')
        ORDER BY i.closed_at DESC LIMIT 1`,
    )
    .get(f.key);
  const closedAt = prior?.closed_at == null ? NaN : Date.parse(prior.closed_at);
  if (prior === null || !(now - closedAt < SHARED_WINDOW_MS)) return undefined;
  const told = prior.commented_at !== null && Date.parse(prior.commented_at) >= closedAt;
  return { issueId: prior.issue_id, closedAt, told };
}

/** Whether a recent fix holds the finding back: told already, or too few reds since it landed. */
const heldByFix = (db: Database, f: Finding, fix: RecentFix): boolean =>
  fix.told || pullsFailedSince(db, f.cause ?? "", fix.closedAt) < SHARED_PULLS;

/**
 * A shared test fixed within the hour files nothing new (#8185). With fewer
 * than SHARED_PULLS pulls red on it on checks created after the fix landed,
 * it says nothing; with that many, it tells the closed issue once, as
 * `continuesDone` does. Undefined when no fix is that recent.
 */
function sinceFix(app: App, repo: Repo, actor: User, f: Finding, evidence: string, at: string, now: number): 0 | 1 | undefined {
  const fix = recentFix(app.db, f, now);
  if (fix === undefined) return undefined;
  if (heldByFix(app.db, f, fix)) return 0;
  const issue = getIssueById(app.db, fix.issueId);
  if (issue === undefined) return 0;
  const pulls = pullsFailedSince(app.db, f.cause ?? "", fix.closedAt);
  const said = addComment(
    app,
    actor,
    repo,
    issue,
    `Still red after the fix landed at ${new Date(fix.closedAt).toISOString()}: ${pulls} pulls failed it on checks created since; the fix may not be live yet. At ${at}; evidence now:\n${f.evidence.map((e) => `- ${e}`).join("\n")}`,
  );
  if (!said.ok) {
    log.warn("sentinel could not comment", { key: f.key, error: String(said.error) });
    return 0;
  }
  app.db
    .query("UPDATE sentinel_finding SET commented_at = ?1, last_seen = ?1, evidence = ?2 WHERE key = ?3 AND issue_id = ?4")
    .run(at, evidence, f.key, fix.issueId);
  return 1;
}

/** The test a shared finding names, read back from its evidence. */
const testOf = (evidence: readonly string[]): string | undefined =>
  evidence.find((e) => e.startsWith("test: "))?.slice(6);

/** A finding's test, or, once its runs left the hour's window, the one its last record named. */
function testFor(db: Database, f: Finding): string | undefined {
  const named = testOf(f.evidence);
  if (named !== undefined || f.cause?.startsWith("shared:") !== true) return named;
  const last = db
    .query<{ evidence: string }, [string]>(
      "SELECT evidence FROM sentinel_finding WHERE key = ?1 ORDER BY last_seen DESC LIMIT 1",
    )
    .get(f.key);
  return last === null ? undefined : testOf(last.evidence.split("\n"));
}

interface Settled {
  readonly at: number;
  readonly evidence: readonly string[];
}

/**
 * A shared red that ended by itself (#8287): its span has closed, no pull
 * failed the test on a check created since, and main's newest check, created
 * after the span closed, passes it: a main check from before the red ended
 * says nothing about it. Undefined while any of those does not hold, or the
 * test is unknown.
 */
function settled(db: Database, cause: string, test: string | undefined, now: number): Settled | undefined {
  if (!cause.startsWith("shared:") || test === undefined) return undefined;
  let at = -Infinity;
  for (const s of spans(db, now - DAY_MS, now)) {
    if (s.cause !== cause) continue;
    if (s.closedAt === null) return undefined;
    at = Math.max(at, s.closedAt);
  }
  if (at === -Infinity) return undefined;
  const pulls = pullsFailedSince(db, cause, at);
  if (pulls > 0) return undefined;
  const main = mainVerdict(db, cause.split(":")[1] ?? "", test);
  if (main === undefined || !main.passes) return undefined;
  const created = db.query<{ created_at: string }, [string]>("SELECT created_at FROM run WHERE id = ?1").get(main.runId);
  if (created === null || !(Date.parse(created.created_at) > at)) return undefined;
  return {
    at,
    evidence: [
      `cause: ${cause}`,
      `test: ${test}`,
      `span closed: ${new Date(at).toISOString()}`,
      `pulls failed it on checks created since: ${pulls}`,
      `main: passes on main's newest check, run ${main.runId} at ${main.commitOid}, created ${created.created_at}`,
    ],
  };
}

/** A finding's cause, read back from its evidence, once its span has left the day. */
const causeOf = (evidence: readonly string[]): string | undefined =>
  evidence.find((e) => e.startsWith("cause: "))?.slice(7);

/**
 * Why a shared finding's test is each pull's own (#8786): main's newest
 * check passes it and no re-run since `since` passed it. Undefined while
 * the test is the lane's, or unknown.
 */
function ownedByPulls(db: Database, cause: string, test: string | undefined, since: number): string[] | undefined {
  if (!cause.startsWith("shared:") || test === undefined) return undefined;
  const repoId = cause.split(":")[1] ?? "";
  if (!pullsOwn(db, repoId, test, since)) return undefined;
  const main = mainVerdict(db, repoId, test);
  if (main === undefined) return undefined;
  return [
    `cause: ${cause}`,
    `test: ${test}`,
    `main: passes on main's newest check, run ${main.runId} at ${main.commitOid}`,
    `re-runs that passed it since ${new Date(since).toISOString()}: none`,
  ];
}

/**
 * A shared red that passed again on its own closes its own open issue as
 * dropped, before a builder is handed it and finds nothing to fix (#8287);
 * so does one the rule now calls each pull's own (#8786: main passes it and
 * no re-run did), saying so — its cause read from the issue's evidence when
 * its span has left the day.
 * Not one a person has spoken on: they decide. If the cause opens again,
 * the next hunt files it fresh and quotes this one. A sentinel that may not
 * close issues here closes nothing and says so: no access check is skipped.
 *
 * It runs on every `sentinelTick`, not only in the hourly `hunt`, because a
 * builder may take an open issue on any tick; `hunt` runs it too, first, so
 * a hunt never comments on an issue it is about to close.
 */
function settleShared(app: App, repo: Repo, actor: User, now: number): void {
  const open = app.db
    .query<{ key: string; issue_id: string; evidence: string; first_seen: string }, []>(
      `SELECT t.key, t.issue_id, t.evidence, t.first_seen FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE i.state = 'open' AND t.key LIKE 'degraded:shared-%'`,
    )
    .all();
  if (open.length === 0) return;
  if (!canWrite(app.db, repo, actor)) {
    log.warn("sentinel may not close issues here; a settled shared red stays open", { repo: repo.id });
    return;
  }
  const causes = new Map(spans(app.db, now - DAY_MS, now).map((s) => [`degraded:${keyPart(s.cause)}`, s.cause]));
  for (const t of open) {
    try {
      const evidence = t.evidence.split("\n");
      const cause = causes.get(t.key) ?? causeOf(evidence);
      if (cause === undefined || `degraded:${keyPart(cause)}` !== t.key) continue;
      const test = testOf(evidence);
      const firstSeen = Date.parse(t.first_seen);
      const owned = ownedByPulls(app.db, cause, test, (Number.isNaN(firstSeen) ? now : firstSeen) - SHARED_WINDOW_MS);
      const done = owned === undefined ? settled(app.db, cause, test, now) : undefined;
      if ((owned === undefined && done === undefined) || personSpoke(app.db, t.issue_id)) continue;
      const issue = getIssueById(app.db, t.issue_id);
      if (issue === undefined || issue.repoId !== repo.id) continue;
      const said = addComment(
        app,
        actor,
        repo,
        issue,
        owned !== undefined
          ? [
              "Each pull's own red, not the lane's (#8786): main's newest check passes this test and no re-run of a failing pull passed it, so each pull failed it for what it added. Evidence:",
              ...owned.map((e) => `- ${e}`),
              "",
              "Closing as dropped: there is nothing for the lane to fix. Each pull's builder gets its red as its own follow-up, with the test named.",
            ].join("\n")
          : [
              `Passed again on its own at ${new Date(done!.at).toISOString()}; evidence:`,
              ...done!.evidence.map((e) => `- ${e}`),
              "",
              "Closing as dropped: there is nothing to fix. If it opens again it is filed fresh, quoting this.",
            ].join("\n"),
      );
      if (!said.ok) {
        log.warn("sentinel could not comment", { key: t.key, error: String(said.error) });
        continue;
      }
      const closed = setIssueState(app, actor, repo, issue, "closed", { reason: "dropped", system: true });
      if (!closed.ok) {
        log.warn("sentinel could not close", { key: t.key, error: String(closed.error) });
        continue;
      }
      // When it settled, on the forge's clock: the repeat rule reads this, never the comment's words.
      app.db
        .query("UPDATE sentinel_finding SET commented_at = ?1 WHERE key = ?2 AND issue_id = ?3")
        .run(new Date(now).toISOString(), t.key, t.issue_id);
    } catch (error) {
      log.error("sentinel settle failed", { key: t.key, error: String(error) });
    }
  }
}

/**
 * The issue a shared cause settled on within the day, and what the sentinel
 * said closing it: a repeat is filed fresh and quotes it (#8287).
 */
function settledBefore(db: Database, actor: User, f: Finding, now: number): string | undefined {
  if (f.cause?.startsWith("shared:") !== true) return undefined;
  // A dropped finding's `commented_at` is when it settled (`settleShared`); done and split ones keep theirs.
  const prior = db
    .query<{ issue_id: string; number: number; commented_at: string }, [string]>(
      `SELECT t.issue_id, i.number, t.commented_at FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = ?1 AND i.state = 'closed' AND i.close_reason = 'dropped' AND t.commented_at IS NOT NULL
        ORDER BY t.commented_at DESC LIMIT 1`,
    )
    .get(f.key);
  if (prior === null || !(now - Date.parse(prior.commented_at) < DAY_MS)) return undefined;
  // What it said closing it: its last comment there.
  const said = db
    .query<{ body: string }, [string, string]>(
      "SELECT body FROM comment WHERE issue_id = ?1 AND author_id = ?2 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(prior.issue_id, actor.id);
  if (said === null) return undefined;
  return [
    "",
    `**Opened again within a day of #${prior.number}**, which the sentinel closed as passed on its own:`,
    ...said.body.split("\n").map((l) => `> ${l}`),
  ].join("\n");
}

/**
 * A finding backed by an incident whose cause has stayed out of the degraded
 * history for a day is done: the sentinel says since when and closes it. Not a
 * setting (its own rule), and not one a person has spoken on — they decide.
 * `active` are the keys found now; a finding that is there is not held.
 */
function closeHeld(app: App, repo: Repo, actor: User, active: ReadonlySet<string>, now: number): void {
  const open = app.db
    .query<{ key: string; issue_id: string }, []>(
      `SELECT t.key, t.issue_id FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE i.state = 'open' AND t.key LIKE 'degraded:%'`,
    )
    .all();
  if (open.length === 0) return;
  const history = spans(app.db, now - 30 * DAY_MS, now);
  for (const t of open) {
    try {
      if (active.has(t.key)) continue;
      let since = -Infinity;
      let live = false;
      for (const s of history) {
        if (`degraded:${keyPart(s.cause)}` !== t.key) continue;
        if (s.closedAt === null) live = true;
        else since = Math.max(since, s.closedAt);
      }
      if (live || since === -Infinity || now - since < DAY_MS) continue;
      if (personSpoke(app.db, t.issue_id)) continue;
      const issue = getIssueById(app.db, t.issue_id);
      if (issue === undefined || issue.repoId !== repo.id) continue;
      const said = addComment(
        app,
        actor,
        repo,
        issue,
        `Held since ${new Date(since).toISOString()}: no new incident on this cause for over a day. Closing as done; if it comes back it is filed again.`,
      );
      if (!said.ok) {
        log.warn("sentinel could not comment", { key: t.key, error: String(said.error) });
        continue;
      }
      const closed = setIssueState(app, actor, repo, issue, "closed", { reason: "done", system: true });
      if (!closed.ok) log.warn("sentinel could not close", { key: t.key, error: String(closed.error) });
    } catch (error) {
      log.error("sentinel close failed", { key: t.key, error: String(error) });
    }
  }
}

/**
 * Read, file, record. One open issue per finding: a tracked finding whose
 * issue is open is commented on only when its evidence changed; one whose
 * issue is closed and returns is a new issue. A setting away from its default
 * is no finding: the capacity page says so beside it (#3269). `find` is the
 * detectors, `findFaults` unless a test files findings of its own.
 */
export function hunt(
  app: App,
  repoPath: string,
  now = Date.now(),
  find: typeof findFaults = findFaults,
): HuntResult {
  const at = new Date(now).toISOString();
  let filed = 0;
  let commented = 0;
  const [owner = "", name = ""] = repoPath.split("/");
  const repo = getRepo(app.db, owner, name);
  const findings = find(app.db, now, repo?.id, app.config.dataDir, forgeCeiling(app.config));
  const actor = sentinelActor(app.db);
  if (repo !== undefined && actor !== undefined) {
    settleShared(app, repo, actor, now);
    for (const f of findings) {
      try {
        const evidence = f.evidence.join("\n");
        const tracked = app.db
          .query<
            { issue_id: string; evidence: string },
            [string]
          >(`SELECT t.issue_id, t.evidence FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
              WHERE t.key = ?1 AND i.state = 'open' LIMIT 1`)
          .get(f.key);
        if (tracked !== null) {
          // The stored evidence moves only once the comment is made: a
          // comment that failed is tried again by the next hunt.
          if (tracked.evidence !== evidence) {
            const issue = getIssueById(app.db, tracked.issue_id);
            if (issue === undefined) continue;
            const said = addComment(app, actor, repo, issue, `Still there at ${at}, evidence now:\n${f.evidence.map((e) => `- ${e}`).join("\n")}`);
            if (!said.ok) {
              log.warn("sentinel could not comment", { key: f.key, error: String(said.error) });
              continue;
            }
            commented++;
          }
          app.db
            .query("UPDATE sentinel_finding SET last_seen = ?1, evidence = ?2 WHERE key = ?3 AND issue_id = ?4")
            .run(at, evidence, f.key, tracked.issue_id);
          continue;
        }
        // A shared red that passed again on its own is no work: the day's total does not file it again.
        if (settled(app.db, f.cause ?? "", testFor(app.db, f), now) !== undefined) continue;
        // Nor is each pull's own red (#8786): its builders hold it, not the lane.
        if (ownedByPulls(app.db, f.cause ?? "", testFor(app.db, f), now - SHARED_WINDOW_MS) !== undefined) continue;
        const told =
          sinceFix(app, repo, actor, f, evidence, at, now) ??
          (f.incident === undefined ? undefined : continuesDone(app, repo, actor, f, evidence, at, now));
        if (told !== undefined) {
          commented += told;
          continue;
        }
        const title = `Sentinel: ${clip(f.title, 200)}`;
        // An issue already filed under this title whose record was lost
        // (the insert failed last hunt) is adopted, not filed twice.
        const adopted = app.db
          .query<{ id: string }, [string, string, string]>(
            "SELECT id FROM issue WHERE repo_id = ?1 AND title = ?2 AND author_id = ?3 AND state = 'open' AND kind = 'issue' ORDER BY created_at DESC LIMIT 1",
          )
          .get(repo.id, title, actor.id);
        let issueId = adopted?.id;
        if (issueId === undefined) {
          const body = bodyOf(f, at) + (settledBefore(app.db, actor, f, now) ?? "");
          const made = openIssue(app, actor, repo, { title, body });
          if (!made.ok) {
            log.warn("sentinel could not file", { key: f.key, error: String(made.error) });
            continue;
          }
          issueId = made.value.id;
          filed++;
          labelFinding(app, repo, actor, made.value, f);
        } else {
          // Adopted: its labels may have been lost with its record.
          const issue = getIssueById(app.db, issueId);
          if (issue !== undefined) labelFinding(app, repo, actor, issue, f);
        }
        app.db
          .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen, incident) VALUES (?1, ?2, ?3, ?4, ?4, ?5)")
          .run(f.key, issueId, evidence, at, f.incident ?? null);
      } catch (error) {
        log.error("sentinel filing failed", { key: f.key, error: String(error) });
      }
    }
  }
  if (repo !== undefined && actor !== undefined) {
    const active = new Set(findings.map((f) => f.key));
    closeHeld(app, repo, actor, active, now);
    closeCaughtUp(app, repo, actor, active, now);
    closeLaneMoving(app, repo, actor, active, now);
  }
  // A hunt with nowhere to file is recorded as such, never as a quiet one.
  const unfiled = repo === undefined || actor === undefined;
  app.db
    .query("INSERT INTO sentinel_hunt (at, found, filed) VALUES (?1, ?2, ?3)")
    .run(at, findings.length, unfiled ? UNFILED : filed);
  return {
    found: findings.length,
    filed,
    commented,
    ...(unfiled ? { cannotFile: cannotFile(app.db, repoPath) ?? "nothing to file with" } : {}),
  };
}

// ---- standing ----

export interface SentinelStanding {
  readonly lastHuntAt: string | null;
  readonly openFindings: number;
  /** The last hunt had no repository or author to file with. */
  readonly lastUnfiled: boolean;
}

export function sentinelStanding(db: Database): SentinelStanding {
  const last = db
    .query<{ at: string; filed: number }, []>("SELECT at, filed FROM sentinel_hunt ORDER BY id DESC LIMIT 1")
    .get();
  const open = db
    .query<{ n: number }, []>(
      `SELECT COUNT(DISTINCT t.key) AS n FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open'`,
    )
    .get();
  return {
    lastHuntAt: last?.at ?? null,
    openFindings: open?.n ?? 0,
    lastUnfiled: last?.filed === UNFILED,
  };
}

/** The one line the board and the terminal show: what is open, or nothing. */
export function sentinelLine(db: Database): string | null {
  const s = sentinelStanding(db);
  if (s.openFindings === 0) return null;
  return `The sentinel has ${s.openFindings} open ${s.openFindings === 1 ? "finding" : "findings"}`;
}

/** The line with its last hunt, for a site admin's board strip and terminal; null before the first hunt. */
export function sentinelSummary(db: Database): string | null {
  const s = sentinelStanding(db);
  if (s.lastHuntAt === null) return sentinelLine(db);
  const when = s.lastHuntAt.slice(0, 16).replace("T", " ");
  const why = s.lastUnfiled ? cannotFile(db) : undefined;
  if (s.lastUnfiled)
    return `The sentinel cannot file: ${why ?? "its last hunt had nowhere to file"} · last hunt ${when}`;
  return `${sentinelLine(db) ?? "The sentinel found nothing"} · last hunt ${when}`;
}

/**
 * Hunt when it is time: an hour since the last, or a signal (a slot held) not yet tracked, and not within ten minutes of the last.
 */
export function sentinelTick(app: App, now = Date.now()): HuntResult | null {
  const repoPath = sentinelRepoPath();
  const last = sentinelStanding(app.db).lastHuntAt;
  const since = last === null ? Infinity : now - new Date(last).getTime();
  const [own = "", ownName = ""] = repoPath.split("/");
  const ownRepo = getRepo(app.db, own, ownName);
  // Every tick, before a builder takes it: see `settleShared`.
  const actor = sentinelActor(app.db);
  if (ownRepo !== undefined && actor !== undefined) settleShared(app, ownRepo, actor, now);
  const breaches = budgetBreaches(app.db, now, ownRepo?.id);
  if (since < SIGNAL_GAP_MS && breaches.length === 0) return null;
  if (since < HUNT_EVERY_MS) {
    // A breach is not held back by the gap: the crew hears within a tick.
    const signals = [
      ...breaches,
      ...(since < SIGNAL_GAP_MS ? [] : heldSlots(app.db, now)),
    ];
    const tracked = new Set(
      app.db
        .query<{ key: string }, []>(
          "SELECT t.key FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open'",
        )
        .all()
        .map((r) => r.key),
    );
    // A shared test held back by its recent fix is no signal: no hunt a tick for its hour.
    const held = (s: Finding): boolean => {
      const fix = recentFix(app.db, s, now);
      return fix !== undefined && heldByFix(app.db, s, fix);
    };
    if (!signals.some((s) => !tracked.has(s.key) && !held(s))) return null;
  }
  return hunt(app, repoPath, now);
}

/**
 * What the board's strip says, only when there is something to act on: open
 * findings, or a sentinel that cannot file. Null otherwise — no banner.
 */
export function sentinelNotice(
  db: Database,
): { text: string; href: string } | null {
  const s = sentinelStanding(db);
  const path = sentinelRepoPath();
  const href = `/${path}/issues`;
  if (s.lastUnfiled) {
    const why = cannotFile(db);
    if (why !== undefined) return { text: `The sentinel cannot file: ${why}`, href: "/" };
  }
  const line = sentinelLine(db);
  return line === null ? null : { text: line, href };
}
