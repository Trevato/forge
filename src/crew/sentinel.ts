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
 * this database, and a fix is not opened as a pull by the sentinel — each
 * finding that has a mechanical fix says what it is, and a run of the crew
 * picks the issue up like any other.
 */

import { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { addComment, openIssue } from "../actions/issues.ts";
import {
  CAPACITY_KEYS,
  capacityDefault,
  storedCapacity,
} from "../core/capacity.ts";
import { decisionsSince } from "../core/decisions.ts";
import { getAgentByName } from "../core/agents.ts";
import { getIssueById, getLabel, setAssignee, setIssueLabels as writeLabels, type Issue } from "../core/issues.ts";
import { getRepo, type Repo } from "../core/repos.ts";
import { leaseLapsed, listRunning } from "../core/runs.ts";
import { migrations } from "../core/schema.ts";
import { getUserByName, type User } from "../core/users.ts";
import { migrate } from "../kernel/migrate.ts";
import { createLog, recentErrors, redactSecrets } from "../kernel/log.ts";
import { spans } from "../kernel/degraded_history.ts";
import { QUEUE_WAIT_MAX_MS } from "../kernel/vitals.ts";
import { STALE_AFTER_MS } from "../runs/lease.ts";

const log = createLog("sentinel");

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** A hunt an hour; a signal may bring one sooner, but never within this. */
export const HUNT_EVERY_MS = HOUR_MS;
export const SIGNAL_GAP_MS = 10 * 60_000;
/** A setting away from its default this long is a finding. */
export const SETTING_AWAY_MS = DAY_MS;
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
  /** A budget breach: filed at once, labelled, handed to the sentinel's own run. */
  readonly urgent?: true;
  /** What a person or a run would do, when it is mechanical and reversible. */
  readonly fix?: string;
  /** A setting finding: the value and `updated_at` a person may have kept (#2001). */
  readonly kept?: { readonly value: string; readonly updatedAt: string };
}

const clip = (text: string, n = 200): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;
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
        `sql: ${clip(oneLine(t.sql ?? ""))}`,
      ],
      pillar: "Trust: the database does only what the schema says",
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
      lookFor: `No ${w.kind} run queued for ${QUEUE_WAIT_MAX_MS / 60_000} minutes while the slots are free; a cancelled run's process is gone with it.`,
      fix: "End the process of a cancelled run on the cancel path, and free its slot.",
    });
  }
  return out;
}

/** A capacity setting that is not its default, for more than a day. */
export function settingsAway(db: Database, now: number): Finding[] {
  const out: Finding[] = [];
  for (const key of CAPACITY_KEYS) {
    const value = storedCapacity(db, key);
    if (value === undefined || value === capacityDefault(key)) continue;
    const row = db
      .query<
        { updated_at: string; username: string | null },
        [string]
      >("SELECT s.updated_at, u.username FROM forge_setting s LEFT JOIN user u ON u.id = s.updated_by WHERE s.key = ?1")
      .get(key);
    if (row === null || now - new Date(row.updated_at).getTime() < SETTING_AWAY_MS)
      continue;
    const days = Math.floor((now - new Date(row.updated_at).getTime()) / DAY_MS);
    out.push({
      key: `setting:${key}`,
      title: `Setting ${key} has been away from its default for ${days} days`,
      evidence: [
        `${key} = "${value}", default "${capacityDefault(key)}"`,
        `set by ${row.username ?? "unknown"} at ${row.updated_at}`,
      ],
      pillar: "Trust: a setting is a decision, not a leftover",
      lookFor: `${key} is back at "${capacityDefault(key)}", or someone says why it stays: close this issue with a reason (or comment one; a bare close keeps it too) and the setting is kept, reported again only if its value changes.`,
      kept: { value, updatedAt: row.updated_at },
      fix: `Put it back: clear ${key} on the capacity page (it is recorded and reversible).`,
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
      lookFor: "A retry decision that is not stop, or a green check after a stop.",
    });
  }
  const parks = new Map<string, number>();
  for (const d of decisionsSince(db, "guard", new Date(now - DAY_MS).toISOString()))
    parks.set(d.repoId, (parks.get(d.repoId) ?? 0) + 1);
  for (const [repoId, n] of parks) {
    if (n < 20) continue;
    out.push({
      key: `parks:${repoId}`,
      title: `The guard parked ${n} runs in ${repoSlug(db, repoId)} in a day`,
      evidence: [`${n} \`guard\` decisions since ${new Date(now - DAY_MS).toISOString()}`],
      pillar: "Throughput: the crew spends on work, not on being refused",
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

/** The last runs per repository: a check never green, or pushes that cannot land. */
export function runStreaks(db: Database): Finding[] {
  const out: Finding[] = [];
  const rows = db
    .query<SummaryRow, [number]>(
      `SELECT id, repo_id, kind, state, summary FROM (
         SELECT id, repo_id, kind, state, summary,
                ROW_NUMBER() OVER (PARTITION BY repo_id, kind ORDER BY created_at DESC, id DESC) AS n
           FROM run WHERE kind IN ('check', 'agent') AND state IN ('ok', 'failed')
       ) WHERE n <= ?1`,
    )
    .all(RUNS_READ);
  const groups = new Map<string, SummaryRow[]>();
  for (const r of rows) {
    const k = `${r.repo_id}\u0000${r.kind}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const [k, runs] of groups) {
    const [repoId = "", kind = ""] = k.split("\u0000");
    const failed = runs.filter((r) => r.state === "failed");
    if (kind === "check") {
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
          `${hits.length} say: "${clip(line)}"`,
          `runs: ${hits.slice(0, 5).map((r) => r.id).join(", ")}`,
        ],
        pillar: "Trust: a green check means something",
        lookFor: "A green check run for the repository's newest head.",
      });
    } else {
      // A decline is the run's own decision ("I pushed nothing"), not a push that failed,
      // whether or not the summary leads with it.
      const pushes = failed.filter(
        (r) =>
          !/\bdeclined:/i.test(r.summary) &&
          /\bpush|sandbox|operation not permitted/i.test(r.summary),
      );
      if (pushes.length < STREAK) continue;
      out.push({
        key: `push:${repoId}`,
        title: `Crew runs in ${repoSlug(db, repoId)} keep failing at the push or the sandbox`,
        evidence: [
          `${pushes.length} of the last ${runs.length} agent runs failed with a push or sandbox line`,
          `e.g. "${clip(oneLine(pushes[0]?.summary ?? ""))}"`,
          `runs: ${pushes.slice(0, 5).map((r) => r.id).join(", ")}`,
        ],
        pillar: "Throughput: a crew run can finish what it starts",
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
        `line: ${clip(oneLine(lines[0]?.message ?? ""))}`,
      ],
      pillar: "Reliability: a quiet log",
      lookFor: "No ERROR line of this shape in an hour.",
    });
  }
  return out;
}

/**
 * Each cause whose spans total more than ten minutes in the day ending at
 * `now`, quoting its sentence. Shorter totals stay in the history.
 */
export function degradedCauses(db: Database, now: number): Finding[] {
  const from = now - DAY_MS;
  const byCause = new Map<string, { sentence: string; href: string; first: number; ms: number }>();
  for (const s of spans(db, from, now)) {
    const start = Math.max(s.openedAt, from);
    const held = Math.min(s.closedAt ?? now, now) - start;
    const seen = byCause.get(s.cause);
    // Spans run oldest first: the first sets the open time, the last the sentence.
    byCause.set(s.cause, {
      sentence: s.sentence,
      href: s.href,
      first: seen?.first ?? start,
      ms: (seen?.ms ?? 0) + Math.max(0, held),
    });
  }
  const out: Finding[] = [];
  for (const [cause, d] of byCause) {
    if (d.ms <= DEGRADED_DAY_MS) continue;
    const minutes = Math.round(d.ms / 60_000);
    out.push({
      key: `degraded:${keyPart(cause)}`,
      title: `${cause} was degraded ${minutes} minutes today: ${clip(oneLine(d.sentence), 120)}`,
      evidence: [
        `cause: ${cause}`,
        `sentence: ${oneLine(d.sentence)}`,
        `first open: ${new Date(d.first).toISOString()}`,
        `total: ${minutes} minutes in the day`,
        `href: ${d.href}`,
      ],
      pillar: "P0 Trust: the forge says when it is not well, and is well again",
      lookFor: `\`${cause}\` stays out of the degraded list for a day, or holds under ${DEGRADED_DAY_MS / 60_000} minutes.`,
    });
  }
  return out;
}

/**
 * The causes that are a budget breached: the lane, a silent run, a run
 * killed twice, a red main holding its pulls' checks. The last gets one fix
 * issue (#1971), and `crew/red_fix.ts` keeps other builders off its test.
 */
const BREACH_CAUSE = /^(queue:check|stuck:|budget:|red:)/;

/**
 * Each budget breach that holds right now, however briefly: the crew hears
 * at once, not when the day has added up. The finding shares its key with
 * `degradedCauses`, so one cause is one issue.
 */
export function budgetBreaches(db: Database, now: number): Finding[] {
  const out: Finding[] = [];
  for (const s of spans(db, now - DAY_MS, now)) {
    if (s.closedAt !== null || !BREACH_CAUSE.test(s.cause)) continue;
    out.push({
      key: `degraded:${keyPart(s.cause)}`,
      title: `${s.cause} is past its budget: ${clip(oneLine(s.sentence), 120)}`,
      evidence: [
        `cause: ${s.cause}`,
        `sentence: ${oneLine(s.sentence)}`,
        `since: ${new Date(s.openedAt).toISOString()}`,
        `href: ${s.href}`,
        ...runLogLines(db, s.cause),
      ],
      pillar: "P0 Trust: the forge says when it is not well, and is well again",
      lookFor: `\`${s.cause}\` is gone from the degraded list and the cause is fixed, not waited out.`,
      fix: s.cause.startsWith("red:")
        ? "Fix the failing test on main in one pull. This is the only issue for it: pulls red on the same test wait for main, and no other builder is handed it while this is open."
        : "Diagnose the cause from the evidence and hand the mechanical fix to a builder as its own issue.",
      urgent: true,
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

/** Everything the sentinel reads, in one pass. */
export function findFaults(db: Database, now = Date.now()): Finding[] {
  const found = [
    ...budgetBreaches(db, now),
    ...heldSlots(db, now),
    ...settingsAway(db, now),
    ...strayTriggers(db),
    ...ledgerStreaks(db, now),
    ...runStreaks(db),
    ...repeatedErrors(now),
    ...degradedCauses(db, now),
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

export const sentinelRepoPath = (): string =>
  (process.env.FORGE_SENTINEL_REPO ?? "trevato/forge").trim();

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
 * A breach is crew work at once: the P0 Trust label, and the sentinel
 * assigned, whose run the dispatcher queues on the assignment event. Each
 * step may fail alone (no such label, the actor is a person): the issue is
 * filed either way, and the failure is said.
 */
function handOver(app: App, repo: Repo, actor: User, issue: Issue): void {
  try {
    // The forge acts on its own finding: no access check stands between it
    // and its label, as none stands between it and the issue it just filed.
    const label = getLabel(app.db, repo.id, "P0 Trust");
    if (label === undefined) log.warn("sentinel has no P0 Trust label to apply", { issue: issue.number });
    else {
      writeLabels(app.db, issue.id, [label.id]);
      app.bus.append({
        kind: "issue.labeled",
        repoId: repo.id,
        actorId: actor.id,
        payload: { number: issue.number, labels: [label.name] },
      });
    }
    if (actor.kind !== "agent") return;
    if (setAssignee(app.db, issue.id, actor.id) === undefined) return;
    app.bus.append({
      kind: "issue.assigned",
      repoId: repo.id,
      actorId: actor.id,
      payload: { number: issue.number, assignee: actor.username, agent: true },
    });
  } catch (error) {
    log.error("sentinel could not hand over", { issue: issue.number, error: String(error) });
  }
}

/** The finding is a setting whose kept value and `updated_at` are on record. */
function keptRecorded(db: Database, f: Finding): boolean {
  if (f.kept === undefined) return false;
  const kept = db
    .query<{ value: string; updated_at: string }, [string]>("SELECT value, updated_at FROM sentinel_kept WHERE key = ?1")
    .get(f.key);
  return kept !== null && kept.value === f.kept.value && kept.updated_at === f.kept.updatedAt;
}

/**
 * Whether a person decided to keep this setting as it now stands: its
 * finding was closed, or explained in a comment by a person (not the sentinel, not an agent),
 * after the value was last set. A decision is recorded with the value and
 * `updated_at` it was made at; the same pair is kept, any other is drift.
 */
function settingKept(db: Database, f: Finding, actorId: string, at: string): boolean {
  if (f.kept === undefined) return false;
  if (keptRecorded(db, f)) return true;
  const { value, updatedAt } = f.kept;
  const decided = db
    .query<{ n: number }, [string, string, string]>(
      `SELECT COUNT(*) AS n FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id
        WHERE t.key = ?1 AND ((i.state = 'closed' AND i.closed_at >= ?2)
          OR EXISTS (SELECT 1 FROM comment c WHERE c.issue_id = i.id AND c.author_id <> ?3 AND c.created_at >= ?2
            AND EXISTS (SELECT 1 FROM user u WHERE u.id = c.author_id AND u.is_agent = 0 AND u.kind = 'user')))`,
    )
    .get(f.key, updatedAt, actorId);
  if (decided === null || decided.n === 0) return false;
  db.query(
    "INSERT INTO sentinel_kept (key, value, updated_at, kept_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3, kept_at = ?4",
  ).run(f.key, value, updatedAt, at);
  return true;
}

/**
 * Read, file, record. One open issue per finding: a tracked finding whose
 * issue is open is commented on only when its evidence changed; one whose
 * issue is closed and returns is a new issue — except a setting a person
 * kept (`settingKept`), which stays quiet until its value changes.
 */
export function hunt(
  app: App,
  repoPath: string,
  now = Date.now(),
): HuntResult {
  const at = new Date(now).toISOString();
  const findings = findFaults(app.db, now);
  let filed = 0;
  let commented = 0;
  const [owner = "", name = ""] = repoPath.split("/");
  const repo = getRepo(app.db, owner, name);
  const actor = sentinelActor(app.db);
  if (repo !== undefined && actor !== undefined) {
    for (const f of findings) {
      try {
        if (settingKept(app.db, f, actor.id, at)) continue;
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
          const made = openIssue(app, actor, repo, { title, body: bodyOf(f, at) });
          if (!made.ok) {
            log.warn("sentinel could not file", { key: f.key, error: String(made.error) });
            continue;
          }
          issueId = made.value.id;
          filed++;
          if (f.urgent) handOver(app, repo, actor, made.value);
        }
        app.db
          .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)")
          .run(f.key, issueId, evidence, at);
      } catch (error) {
        log.error("sentinel filing failed", { key: f.key, error: String(error) });
      }
    }
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
 * Hunt when it is time: an hour since the last, or a signal (a slot held, a
 * setting away) not yet tracked, and not within ten minutes of the last.
 */
export function sentinelTick(app: App, now = Date.now()): HuntResult | null {
  const repoPath = sentinelRepoPath();
  const last = sentinelStanding(app.db).lastHuntAt;
  const since = last === null ? Infinity : now - new Date(last).getTime();
  const breaches = budgetBreaches(app.db, now);
  if (since < SIGNAL_GAP_MS && breaches.length === 0) return null;
  if (since < HUNT_EVERY_MS) {
    // A breach is not held back by the gap: the crew hears within a tick.
    const signals = [
      ...breaches,
      ...(since < SIGNAL_GAP_MS ? [] : [...heldSlots(app.db, now), ...settingsAway(app.db, now)]),
    ];
    const tracked = new Set(
      app.db
        .query<{ key: string }, []>(
          "SELECT t.key FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open'",
        )
        .all()
        .map((r) => r.key),
    );
    if (!signals.some((s) => !tracked.has(s.key) && !keptRecorded(app.db, s))) return null;
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
