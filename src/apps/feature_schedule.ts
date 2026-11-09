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
import { lastFires, recordFire } from "../core/feature_fires.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import { callTool } from "./feature_tools.ts";
import type { ScheduleEntry } from "./feature.ts";
import { appsRuntime } from "./runtime.ts";

/** The entries whose interval has passed since they last fired (never fired: due). `lastFired` is ms by tool. */
export function due(schedule: readonly ScheduleEntry[], lastFired: ReadonlyMap<string, number>, now: number): ScheduleEntry[] {
  return schedule.filter((e) => {
    const last = lastFired.get(e.tool);
    return last === undefined || now - last >= e.everyMs;
  });
}

const inFlight = new Set<string>();

/** What `fireApp` needs from the running forge: the production port when running, and the declared schedule. */
export interface Reach {
  port(): number | undefined;
  /** The feature as the app declares it now: its tools and its schedule. */
  declared(): Promise<{ readonly tools: readonly string[]; readonly schedule: readonly ScheduleEntry[] }>;
}

/** Call every due scheduled tool of one app if it is absorbed and running; the tools called. */
export async function fireApp(db: Database, appId: string, reach: Reach, now: () => number = Date.now): Promise<string[]> {
  if (getAbsorbed(db, appId) === undefined) return [];
  const port = reach.port();
  if (port === undefined) return [];
  const declared = await reach.declared();
  const schedule = declared.schedule.filter((e) => declared.tools.includes(e.tool));
  if (schedule.length === 0) return [];
  const last = new Map(lastFires(db, appId).map((f) => [f.tool, f.at]));
  const called: string[] = [];
  for (const entry of due(schedule, last, now())) {
    const key = `${appId}:${entry.tool}`;
    if (inFlight.has(key)) continue;
    inFlight.add(key);
    try {
      const started = now();
      const answer = await callTool(port, entry.tool, {});
      const ended = now();
      recordFire(db, appId, {
        tool: entry.tool,
        at: started,
        ok: answer.ok,
        error: answer.ok ? null : answer.error,
        durationMs: Math.max(0, ended - started),
      });
      called.push(entry.tool);
    } finally {
      inFlight.delete(key);
    }
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
): Promise<{ ok: true } | { ok: false; why: FireOneRefusal }> {
  if (getAbsorbed(db, appId) === undefined) return { ok: false, why: "not_absorbed" };
  const key = `${appId}:${tool}`;
  if (inFlight.has(key)) return { ok: false, why: "in_flight" };
  const port = reach.port();
  if (port === undefined) return { ok: false, why: "asleep" };
  inFlight.add(key);
  try {
    const declared = await reach.declared().catch(() => undefined);
    if (declared === undefined || !declared.tools.includes(tool) || !declared.schedule.some((e) => e.tool === tool)) return { ok: false, why: "not_scheduled" };
    const started = now();
    // callTool is bounded (WAIT_MS) and answers an error rather than throwing; a throw is still a recorded failure.
    const answer = await callTool(port, tool, {}).catch((): { ok: false; error: string } => ({ ok: false, error: "the app did not answer" }));
    recordFire(db, appId, {
      tool,
      at: started,
      ok: answer.ok,
      error: answer.ok ? null : answer.error,
      durationMs: Math.max(0, now() - started),
    });
    return { ok: true };
  } finally {
    inFlight.delete(key);
  }
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
    void fireDue(app).finally(() => (running = false));
  }, tickMs);
  tick.unref();
  return { stop: () => clearInterval(tick) };
}
