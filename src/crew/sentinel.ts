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
import { listIssues } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import { leaseLapsed, listRunning } from "../core/runs.ts";
import { migrations } from "../core/schema.ts";
import { getUserByName, type User } from "../core/users.ts";
import { migrate } from "../kernel/migrate.ts";
import { createLog, recentErrors } from "../kernel/log.ts";
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
  /** What a person or a run would do, when it is mechanical and reversible. */
  readonly fix?: string;
}

const clip = (text: string, n = 200): string =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text;
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const keyPart = (text: string): string =>
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
  const known = schemaTriggers();
  return db
    .query<
      { name: string; tbl_name: string; sql: string | null },
      []
    >("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
    .all()
    .filter((t) => !known.has(t.name))
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
      lookFor: `${key} is back at "${capacityDefault(key)}", or someone says in a comment why it stays.`,
      fix: `Put it back: clear ${key} on the capacity page (it is recorded and reversible).`,
    });
  }
  return out;
}

/** The crew's stops and guard parks, read from the decision ledger. */
export function ledgerStreaks(db: Database, now: number): Finding[] {
  const out: Finding[] = [];
  const since = new Date(now - 7 * DAY_MS).toISOString();
  const byRepo = new Map<string, { stops: string[]; total: number }>();
  for (const d of decisionsSince(db, "retry", since)) {
    const r = byRepo.get(d.repoId) ?? { stops: [], total: 0 };
    r.total++;
    if (d.answer === "stop") r.stops.push(d.id);
    byRepo.set(d.repoId, r);
  }
  for (const [repoId, r] of byRepo) {
    if (r.stops.length < STREAK || r.stops.length !== r.total) continue;
    out.push({
      key: `stops:${repoId}`,
      title: `Every retry decision in ${repoSlug(db, repoId)} this week was stop`,
      evidence: [
        `${r.stops.length} of ${r.total} \`retry\` decisions answered stop since ${since}`,
        `decisions: ${r.stops.slice(0, 5).join(", ")}`,
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
      const pushes = failed.filter((r) => /\bpush|sandbox|operation not permitted/i.test(r.summary));
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
  const seen = recentErrors(100, now).latest;
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

/** Everything the sentinel reads, in one pass. */
export function findFaults(db: Database, now = Date.now()): Finding[] {
  return [
    ...heldSlots(db, now),
    ...settingsAway(db, now),
    ...strayTriggers(db),
    ...ledgerStreaks(db, now),
    ...runStreaks(db),
    ...repeatedErrors(now),
  ];
}

// ---- filing ----

export interface HuntResult {
  readonly found: number;
  readonly filed: number;
  readonly commented: number;
}

let hunting = false;
/** Whether a hunt is under way: the home's one line while it is. */
export const huntOn = (): boolean => hunting;

function sentinelActor(app: App): User | undefined {
  if (getAgentByName(app.db, "sentinel") !== undefined)
    return getUserByName(app.db, "sentinel");
  const admin = app.db
    .query<{ username: string }, []>(
      "SELECT username FROM user WHERE is_admin = 1 ORDER BY created_at LIMIT 1",
    )
    .get();
  return admin === null ? undefined : getUserByName(app.db, admin.username);
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
 * Read, file, record. One open issue per finding: a tracked finding whose
 * issue is open is commented on only when its evidence changed; one whose
 * issue is closed and returns is a new issue.
 */
export function hunt(
  app: App,
  repoPath: string,
  now = Date.now(),
): HuntResult {
  hunting = true;
  try {
    const at = new Date(now).toISOString();
    const findings = findFaults(app.db, now);
    let filed = 0;
    let commented = 0;
    const [owner = "", name = ""] = repoPath.split("/");
    const repo = getRepo(app.db, owner, name);
    const actor = sentinelActor(app);
    if (repo !== undefined && actor !== undefined) {
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
            app.db
              .query("UPDATE sentinel_finding SET last_seen = ?1, evidence = ?2 WHERE key = ?3 AND issue_id = ?4")
              .run(at, evidence, f.key, tracked.issue_id);
            if (tracked.evidence !== evidence) {
              const issue = listIssues(app.db, repo.id, { state: "open", limit: 200 }).find(
                (i) => i.id === tracked.issue_id,
              );
              if (issue !== undefined) {
                addComment(app, actor, repo, issue, `Still there at ${at}, evidence now:\n${f.evidence.map((e) => `- ${e}`).join("\n")}`);
                commented++;
              }
            }
            continue;
          }
          const made = openIssue(app, actor, repo, {
            title: `Sentinel: ${clip(f.title, 200)}`,
            body: bodyOf(f, at),
          });
          if (!made.ok) {
            log.warn("sentinel could not file", { key: f.key, error: String(made.error) });
            continue;
          }
          app.db
            .query("INSERT INTO sentinel_finding (key, issue_id, evidence, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)")
            .run(f.key, made.value.id, evidence, at);
          filed++;
        } catch (error) {
          log.error("sentinel filing failed", { key: f.key, error: String(error) });
        }
      }
    }
    app.db
      .query("INSERT INTO sentinel_hunt (at, found, filed) VALUES (?1, ?2, ?3)")
      .run(at, findings.length, filed);
    return { found: findings.length, filed, commented };
  } finally {
    hunting = false;
  }
}

// ---- standing ----

export interface SentinelStanding {
  readonly lastHuntAt: string | null;
  readonly lastFound: number;
  readonly openFindings: number;
}

export function sentinelStanding(db: Database): SentinelStanding {
  const last = db
    .query<{ at: string; found: number }, []>("SELECT at, found FROM sentinel_hunt ORDER BY id DESC LIMIT 1")
    .get();
  const open = db
    .query<{ n: number }, []>(
      `SELECT COUNT(DISTINCT t.key) AS n FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open'`,
    )
    .get();
  return {
    lastHuntAt: last?.at ?? null,
    lastFound: last?.found ?? 0,
    openFindings: open?.n ?? 0,
  };
}

/** The one line the home and the board show: while a hunt is on, or what the last found. */
export function sentinelLine(db: Database): string | null {
  if (hunting) return "The sentinel is hunting for faults…";
  const s = sentinelStanding(db);
  if (s.openFindings === 0) return null;
  return `The sentinel has ${s.openFindings} open ${s.openFindings === 1 ? "finding" : "findings"}`;
}

/**
 * Hunt when it is time: an hour since the last, or a signal (a slot held, a
 * setting away) not yet tracked, and not within ten minutes of the last.
 */
export function sentinelTick(app: App, now = Date.now()): HuntResult | null {
  const repoPath = (process.env.FORGE_SENTINEL_REPO ?? "trevato/forge").trim();
  const last = sentinelStanding(app.db).lastHuntAt;
  const since = last === null ? Infinity : now - new Date(last).getTime();
  if (since < SIGNAL_GAP_MS) return null;
  if (since < HUNT_EVERY_MS) {
    const signals = [...heldSlots(app.db, now), ...settingsAway(app.db, now)];
    const tracked = new Set(
      app.db
        .query<{ key: string }, []>(
          "SELECT t.key FROM sentinel_finding t JOIN issue i ON i.id = t.issue_id WHERE i.state = 'open'",
        )
        .all()
        .map((r) => r.key),
    );
    if (!signals.some((s) => !tracked.has(s.key))) return null;
  }
  return hunt(app, repoPath, now);
}
