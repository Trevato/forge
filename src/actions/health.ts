/**
 * How the forge is, as it answers anyone who asks: the version and commit
 * it runs, whether it is draining, and the platform's word on its rollout
 * (`kernel/guard.ts`). A monitor has no account, so there is nothing to
 * authorize. A site admin also gets the forge's own vitals alongside, and
 * `ok` is then both.
 *
 * One answer for the API (`GET /api/v1/health`) and the MCP `health` tool.
 */

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

export function readHealth(
  app: App,
  actor: User | undefined,
): ForgeHealth | (Vitals & ForgeHealth) {
  const forge = forgeHealth();
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
  ];
}

export { sinceWords };

/** A cause as one line: its sentence and when it began (a stuck run's says so already). */
export function needLine(d: Degraded, now: number = Date.now()): string {
  return d.cause.startsWith("stuck:")
    ? d.sentence
    : `${d.sentence} Since ${sinceWords(d.since, now)}.`;
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
