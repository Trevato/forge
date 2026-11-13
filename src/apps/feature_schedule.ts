/**
 * An absorbed app's declared schedule, run: on a tick the forge calls each due
 * tool through the same loopback call the `features` tool uses
 * (`callTool`), with no model and no crew. The last fire of each (app, tool) is
 * kept in `feature_fire`. An app that is not running is skipped, never woken;
 * an app that is not absorbed is never called.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { declaredFeature } from "../actions/features.ts";
import { getAbsorbed } from "../core/features.ts";
import { lastFires, lastScheduled, recordFire, scheduleSince, type Fired, type How, type Run } from "../core/feature_fires.ts";
import { err, type Result } from "../kernel/result.ts";
import { lastSlot, localLabel, nextSlot } from "./feature_clock.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import { callTool } from "./feature_tools.ts";
import { SCHEDULE_EVERY, type ScheduleEntry } from "./feature.ts";
import { appsRuntime } from "./runtime.ts";
import { during } from "../perf/jobs.ts";

/**
 * How long after its clock time a daily `at` may still fire (and say it was late); past it the day
 * is skipped.
 */
export const GRACE_MS = 3 * 3_600_000;
/**
 * A fire this long after its time was not the minute's look but a forge that was away: it is said
 * to be late.
 */
export const LATE_MS = 2 * 60_000;

/**
 * What a look decides for one entry: fire it (and how it is told), skip a day it missed, or
 * nothing.
 */
export type Verdict = { readonly do: "fire"; readonly how: "schedule" | "late" } | { readonly do: "skip"; readonly slot: number } | undefined;

/**
 * Whether the entry is due. An interval counts from the later of its last fire (any way it was
 * started) and when the schedule began to count; a clock time is due once per local day, counted
 * from the later of the schedule's own last act and when it began, so a manual run does not move it
 * and a new schedule waits for its next time. `lastFired` is the last run of any kind,
 * `lastScheduled` the schedule's own last act.
 */
export function due(
  entry: ScheduleEntry,
  seen: { readonly lastFired?: number | undefined; readonly lastScheduled?: number | undefined; readonly since: number },
  now: number,
): Verdict {
  if (entry.at !== undefined && entry.tz !== undefined) {
    const slot = lastSlot(entry.at, entry.tz, now);
    if (slot <= Math.max(seen.lastScheduled ?? 0, seen.since)) return undefined;
    if (now - slot > GRACE_MS) return { do: "skip", slot };
    return { do: "fire", how: now - slot > LATE_MS ? "late" : "schedule" };
  }
  const every = entry.everyMs ?? Infinity;
  return now - Math.max(seen.lastFired ?? 0, seen.since) >= every ? { do: "fire", how: "schedule" } : undefined;
}

/** The entry as the forge compares it from one look to the next. */
const specOf = (e: ScheduleEntry): string => (e.at !== undefined ? `at ${e.at} ${e.tz}` : `every ${e.everyMs}`);

const inFlight = new Set<string>();
export const isRunning = (appId: string, tool: string): boolean => inFlight.has(`${appId}:${tool}`);

/**
 * The one way a tool is run and recorded: the schedule, Run now on the page, the terminal's `r` and
 * the `features` tool (for a scheduled tool) all come through here, so each is the same row in the
 * tool's last fire and its history. `ran: false` means a call of the same tool is already running;
 * it is never doubled.
 */
export async function runRecorded(
  db: Database,
  appId: string,
  tool: string,
  port: number,
  args: Record<string, unknown>,
  how: How,
  now: () => number = Date.now,
): Promise<{ ran: true; answer: Result<unknown, string> } | { ran: false }> {
  const key = `${appId}:${tool}`;
  if (inFlight.has(key)) return { ran: false };
  inFlight.add(key);
  try {
    const started = now();
    // callTool is bounded (WAIT_MS) and answers an error rather than throwing; a throw is still a
    // recorded failure.
    const answer = await callTool(port, tool, args).catch((): Result<unknown, string> => err("the app did not answer"));
    recordFire(db, appId, { tool, at: started, ok: answer.ok, error: answer.ok ? null : answer.error, durationMs: Math.max(0, now() - started) }, how);
    return { ran: true, answer };
  } finally {
    inFlight.delete(key);
  }
}

/** What `fireApp` needs from the running forge: the production port when running, and the declared schedule. */
export interface Reach {
  port(): number | undefined;
  /** The feature as the app declares it now: its tools and its schedule. */
  declared(): Promise<{ readonly tools: readonly string[]; readonly schedule: readonly ScheduleEntry[] }>;
}

/**
 * Look at every scheduled tool of one app if it is absorbed: call the due ones while it runs, note
 * the days missed; the tools called.
 */
export async function fireApp(db: Database, appId: string, reach: Reach, now: () => number = Date.now): Promise<string[]> {
  if (getAbsorbed(db, appId) === undefined) return [];
  const declared = await reach.declared();
  const schedule = declared.schedule.filter((e) => declared.tools.includes(e.tool));
  if (schedule.length === 0) return [];
  const last = new Map(lastFires(db, appId).map((f) => [f.tool, f.at]));
  const called: string[] = [];
  for (const entry of schedule) {
    const at = now();
    const since = scheduleSince(db, appId, entry.tool, specOf(entry), at);
    const verdict = due(entry, { lastFired: last.get(entry.tool), lastScheduled: lastScheduled(db, appId, entry.tool), since }, at);
    if (verdict === undefined) continue;
    if (verdict.do === "skip") {
      const when = localLabel(verdict.slot, entry.tz!);
      recordFire(db, appId, { tool: entry.tool, at, ok: false, error: `skipped ${when}: the forge came back more than ${GRACE_MS / 3_600_000} h late`, durationMs: 0 }, "skipped");
      continue;
    }
    const port = reach.port();
    if (port === undefined) continue;
    const ran = await runRecorded(db, appId, entry.tool, port, {}, verdict.how, now);
    if (ran.ran) called.push(entry.tool);
  }
  return called;
}

/** Why a run now was not made. */
export type FireOneRefusal = "not_absorbed" | "not_scheduled" | "asleep" | "in_flight";

/**
 * Call one scheduled tool now, the way the schedule does, and record it as its
 * fire. A stopped or asleep app is refused, never woken; a call already running
 * for the same (app, tool) is refused, never doubled.
 */
export async function fireOne(
  db: Database,
  appId: string,
  tool: string,
  reach: Reach,
  now: () => number = Date.now,
  how: How = "page",
): Promise<{ ok: true } | { ok: false; why: FireOneRefusal }> {
  if (getAbsorbed(db, appId) === undefined) return { ok: false, why: "not_absorbed" };
  if (isRunning(appId, tool)) return { ok: false, why: "in_flight" };
  const port = reach.port();
  if (port === undefined) return { ok: false, why: "asleep" };
  const declared = await reach.declared().catch(() => undefined);
  if (declared === undefined || !declared.tools.includes(tool) || !declared.schedule.some((e) => e.tool === tool)) return { ok: false, why: "not_scheduled" };
  const ran = await runRecorded(db, appId, tool, port, {}, how, now);
  return ran.ran ? { ok: true } : { ok: false, why: "in_flight" };
}

/** What `fireApp` reaches for one app in the real runtime: only a production that is running, never woken. */
export function runtimeReach(app: App, record: AppRecord): Reach {
  return {
    port: () => {
      const status = appsRuntime(app)?.envStatus(record, "production");
      return status?.state === "running" ? status.port : undefined;
    },
    declared: async () => {
      const repo = getRepoById(app.db, record.repoId);
      if (repo === undefined) return { tools: [], schedule: [] };
      const declared = await declaredFeature(app, repo);
      const spec = declared.ok ? declared.value : undefined;
      return { tools: (spec?.tools ?? []).map((t) => t.name), schedule: spec?.schedule ?? [] };
    },
  };
}

/** Every app, one after another: a slow app delays the next, never overlaps itself. `reachOf` is the seam a test replaces. */
export async function fireDue(
  app: App,
  now: () => number = Date.now,
  reachOf: (record: AppRecord) => Reach = (record) => runtimeReach(app, record),
): Promise<void> {
  for (const record of listApps(app.db)) {
    try {
      await fireApp(app.db, record.id, reachOf(record), now);
    } catch (error) {
      app.log.warn("could not fire a scheduled tool", { app: record.slug, error: String(error) });
    }
  }
}

const TICK_MS = 60_000;

/** The timer. Off under `bun test` (NODE_ENV=test) so no sweep outlives a test; a test that wants it calls `fireDue`. */
export function startFeatureSchedule(app: App, tickMs: number = TICK_MS): { stop(): void } | undefined {
  if (process.env["NODE_ENV"] === "test") return undefined;
  let running = false;
  const tick = setInterval(() => {
    if (running) return;
    running = true;
    void during("feature-schedule", () => fireDue(app)).finally(() => (running = false));
  }, tickMs);
  tick.unref();
  return { stop: () => clearInterval(tick) };
}

/**
 * One scheduled tool as plain data: how often or at what clock time, how its last fire went, when
 * the next is due. Times are ms since the epoch.
 */
export interface ScheduleStatus {
  readonly tool: string;
  /** The interval as declared (`1h`); null for a clock-time entry. */
  readonly every: string | null;
  /** The daily clock time (`07:15`) and its IANA zone; null for an interval entry. */
  readonly at: string | null;
  readonly tz: string | null;
  readonly lastAt: number | null;
  readonly ok: boolean | null;
  /** The failure's sentence; null when the last fire went fine or there is none. */
  readonly error: string | null;
  /** How long the last fire took; null before the first. */
  readonly durationMs: number | null;
  /** When it is next due; null for an interval before the forge has begun counting (due soon). */
  readonly nextAt: number | null;
  /** The whole line as `scheduleLine` words it, for the tool's readers and the terminal. */
  readonly line: string;
}

/** The interval as the app declared it (`15m`, `1h`, `6h`, `1d`). */
function everyWord(everyMs: number): string {
  return Object.entries(SCHEDULE_EVERY).find(([, ms]) => ms === everyMs)?.[0] ?? `${Math.round(everyMs / 60_000)}m`;
}

/**
 * One status per schedule entry, in the app's order, joined to the last fire of its tool. `since`
 * is when each began to count.
 */
export function scheduleStatus(
  schedule: readonly ScheduleEntry[],
  fires: readonly Fired[],
  now: number = Date.now(),
  since: ReadonlyMap<string, number> = new Map(),
): ScheduleStatus[] {
  return schedule.map((e) => {
    const fire = fires.find((f) => f.tool === e.tool);
    const begun = since.get(e.tool);
    const base = Math.max(fire?.at ?? 0, begun ?? 0);
    const clock = e.at !== undefined && e.tz !== undefined;
    const status: Omit<ScheduleStatus, "line"> = {
      tool: e.tool,
      every: clock ? null : everyWord(e.everyMs ?? 0),
      at: e.at ?? null,
      tz: e.tz ?? null,
      lastAt: fire?.at ?? null,
      ok: fire?.ok ?? null,
      durationMs: fire?.durationMs ?? null,
      error: fire === undefined || fire.ok ? null : (fire.error ?? "failed"),
      nextAt: clock ? nextSlot(e.at!, e.tz!, now) : base === 0 ? null : base + (e.everyMs ?? 0),
    };
    return { ...status, line: scheduleLine(status) };
  });
}

/** `every 1h` or `at 07:15 America/Chicago`: when the tool runs, without its name. */
export const scheduleWhen = (s: Pick<ScheduleStatus, "every" | "at" | "tz">): string => (s.at !== null ? `at ${s.at} ${s.tz}` : `every ${s.every}`);

/** `scan every 1h` or `print_today at 07:15 America/Chicago`: the head of the line. */
export const scheduleHead = (s: Pick<ScheduleStatus, "tool" | "every" | "at" | "tz">): string => `${s.tool} ${scheduleWhen(s)}`;

/**
 * One run of the history as a plain line: `print_today · page · 2026-11-13 10:02 · ok · 42 ms`, the
 * error's sentence when it failed (UTC).
 */
export const runLine = (r: Run): string =>
  `${r.tool} · ${r.how} · ${new Date(r.at).toISOString().slice(0, 16).replace("T", " ")} · ${r.ok ? "ok" : (r.error ?? "failed")}${r.how === "skipped" ? "" : ` · ${r.durationMs} ms`}`;

/** `10:02`: the plain-text clock (UTC) of the line the tool and the terminal print. */
export const scheduleClock = (ms: number): string => new Date(ms).toISOString().slice(11, 16);

/** A piece of the line after the head: words, the last or next moment (ms) the reader formats, or the sentence of a failure. */
export type SchedulePiece = string | { readonly last: number } | { readonly next: number } | { readonly error: string };

/**
 * The wording of the line after the head, once, for every door: the page formats the moments and
 * styles the error, the rest print it with `scheduleLine`. A clock-time entry speaks in its own
 * zone (`last Fri 07:15, ok · next Sat 07:15`).
 */
export function scheduleMeta(s: Omit<ScheduleStatus, "line">): SchedulePiece[] {
  if (s.at !== null && s.tz !== null) {
    const next = s.nextAt === null ? "soon" : localLabel(s.nextAt, s.tz);
    if (s.lastAt === null) return [`never run · next ${next}`];
    return ["last ", localLabel(s.lastAt, s.tz), ", ", s.error === null ? "ok" : { error: s.error }, ` · next ${next}`];
  }
  if (s.lastAt === null) return [s.nextAt === null ? "never run · next soon" : "never run · next ", ...(s.nextAt === null ? [] : [{ next: s.nextAt }])];
  return [
    "last ", { last: s.lastAt }, ", ", s.error === null ? "ok" : { error: s.error },
    ...(s.durationMs === null ? [] : [` · ${s.durationMs} ms`]),
    " · next ", { next: s.nextAt ?? s.lastAt },
  ];
}

/** The line for one entry: `scan every 1h · last 10:02, ok · 42 ms · next 11:02` (UTC), the error's sentence when it failed,
    `never run · next soon` before the forge has begun counting. */
export function scheduleLine(s: Omit<ScheduleStatus, "line">): string {
  const word = (p: SchedulePiece): string => (typeof p === "string" ? p : "error" in p ? p.error : scheduleClock("last" in p ? p.last : p.next));
  return `${scheduleHead(s)} · ${scheduleMeta(s).map(word).join("")}`;
}
