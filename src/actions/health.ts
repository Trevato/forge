/**
 * How the forge is, as it answers whoever asks. A monitor has no account,
 * so anyone may ask; what it is told depends on who it is (#2917):
 *
 * - a stranger learns whether the forge is well and whether it is draining,
 *   and nothing of the platform's incidents or rollout. It is also told the
 *   version and commit for one release more — a running forge's swap reads
 *   its successor's commit without a probe (`release/swap.ts` before #2917);
 *   once that forge is gone the stranger's answer is `ok` alone.
 * - anyone signed in, and the forge's own release machinery carrying the
 *   probe (`kernel/probe.ts`), get the whole answer: version, commit,
 *   rollout and the platform's incidents.
 * - a site admin gets the whole answer and the forge's vitals alongside,
 *   `ok` then being both.
 *
 * One answer for the API (`GET /api/v1/health`) and the MCP `health` tool.
 */

import { flakeLine, flakeList, flakeNeeds } from "../checks/flake.ts";
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { listApps } from "../core/apps.ts";
import type { User } from "../core/users.ts";
import { forgeHealth, rolloutLine, type ForgeHealth } from "../kernel/guard.ts";
import {
  laneLine,
  sinceWords,
  vitals,
  type Degraded,
  type Vitals,
  type VitalsInput,
} from "../kernel/vitals.ts";
import { snapshotsOf } from "../snapshot/service.ts";

/** Where this forge's snapshots go, as vitals reads it; undefined when it takes none. */
export function snapshotPlace(app: App): VitalsInput["snapshots"] {
  const handle = snapshotsOf(app);
  if (handle === undefined) return undefined;
  const dir = handle.store?.dir;
  return { ...(dir === undefined ? {} : { dir }), mirrored: handle.mirror !== undefined };
}

/**
 * This forge's vitals, as every surface reads them: the health answer, the
 * board's forge strip and the asks. One place gathers what they measure.
 */
export function forgeVitals(app: App): Vitals {
  const runtime = appsRuntime(app);
  const envs = runtime
    ? listApps(app.db).flatMap((record) => runtime.status(record))
    : [];
  return vitals({
    db: app.db,
    dataDir: app.config.dataDir,
    ...(app.config.disk ? { disk: app.config.disk } : {}),
    envs,
    signals: app.signals,
    forgeUrl: app.config.url ?? `http://localhost:${app.config.port}`,
    snapshots: snapshotPlace(app),
  });
}

/**
 * What a stranger is told: no incident, no rollout, no platform words.
 * Version and commit stay for one release, while a running forge's swap
 * reads its successor's commit without the probe; #2962 removes them.
 */
export type StrangerHealth = Pick<ForgeHealth, "ok" | "version" | "commit" | "draining">;

export function readHealth(
  app: App,
  actor: User | undefined,
  probe = false,
): StrangerHealth | ForgeHealth | (Vitals & ForgeHealth) {
  const forge = forgeHealth();
  if (actor === undefined && !probe) {
    const { ok, version, commit, draining } = forge;
    return { ok, version, commit, draining };
  }
  if (!actor?.isAdmin) return forge;
  const v = forgeVitals(app);
  return { ...v, ...forge, ok: forge.ok && v.ok };
}

/**
 * The forge's causes for concern as one sentence each, for a site admin: the
 * rollout, each platform incident, then the vitals' needs, in the order the
 * board's forge strip prints them. An empty list is "All fine"; `undefined`
 * is anyone else, who is told nothing and costs no reads.
 */
export function forgeNeeds(app: App, actor: User | undefined): string[] | undefined {
  if (!actor?.isAdmin) return undefined;
  const h = readHealth(app, actor) as Vitals & ForgeHealth;
  const rollout = rolloutLine(h);
  return [
    ...(rollout === null ? [] : [rollout]),
    ...h.incidents.map((i) => `${i.key}: ${i.message}`),
    ...h.degraded.map(needLine),
    ...flakeNeeds(h.flakes),
  ];
}

export { sinceWords };

/** A cause as one line: its sentence and when it began (a stuck run's says so already). */
export function needLine(d: Degraded, now: number = Date.now()): string {
  return d.cause.startsWith("stuck:")
    ? d.sentence
    : `${d.sentence} Since ${sinceWords(d.since, now)}.`;
}

/** The week's flaky tests as one line for a site admin; `null` for anyone else, and when none flaked. */
export function forgeFlakes(app: App, actor: User | undefined): string | null {
  return actor?.isAdmin === true ? flakeLine(flakeList(app.db, Date.now())) : null;
}

/**
 * The check lane as one line for a site admin, as the board's forge strip
 * prints it; `null` for anyone else, and when no check is queued.
 */
export function forgeLane(app: App, actor: User | undefined): string | null {
  if (!actor?.isAdmin) return null;
  const h = readHealth(app, actor) as Vitals & ForgeHealth;
  return laneLine(h.lane);
}
