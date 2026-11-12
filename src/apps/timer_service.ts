/**
 * The timer loop in the real forge (#11595): every second it fires what is
 * due (`timer_fire.ts`), and every minute it reads each app's declared
 * `schedules` at the commit each environment serves, once per commit, into
 * rows (`core/timers.ts`). The rows are the state: a restart loses nothing,
 * and a timer that came due meanwhile fires at the next tick, late and said so.
 * Off under `bun test` (NODE_ENV=test) so no loop outlives a test.
 */

import type { App } from "../app.ts";
import { listApps, type AppRecord } from "../core/apps.ts";
import { getRepoById } from "../core/repos.ts";
import { dropGoneEnvs, syncSchedules, syncedCommit } from "../core/timers.ts";
import { readFileAt } from "./checkout.ts";
import { identityKey } from "./proxy.ts";
import { parseManifest } from "./manifest.ts";
import { appsRuntime } from "./runtime.ts";
import type { EnvName } from "./data.ts";
import { fireDueTimers, type Reach } from "./timer_fire.ts";
import { repoDir } from "../git/repos.ts";
import { during } from "../perf/jobs.ts";

export function runtimeReach(app: App): Reach {
  return {
    async ensure(record: AppRecord, env) {
      const rt = appsRuntime(app);
      if (rt === undefined) return undefined;
      const status = rt.envStatus(record, env as EnvName);
      if (status?.state === "running" && status.port !== undefined) return status.port;
      return (await rt.wake(record, env as EnvName))?.port;
    },
    identityKey: (appId) => identityKey(app.config.dataDir, appId),
    fetch,
  };
}

/** Read each app's declared schedules at the commit each environment serves, once per commit. */
export async function syncAll(app: App, now: () => number = Date.now): Promise<void> {
  const rt = appsRuntime(app);
  if (rt === undefined) return;
  for (const record of listApps(app.db)) {
    const live = new Set<string>();
    for (const st of rt.status(record)) {
      if (st.env !== "production" && !st.env.startsWith("pull-")) continue;
      live.add(st.env);
      if (syncedCommit(app.db, record.id, st.env) === st.commitOid) continue;
      const repo = getRepoById(app.db, record.repoId);
      if (repo === undefined) continue;
      const text = await readFileAt(repoDir(app.reposRoot, repo.ownerName, repo.name), st.commitOid, "forge.json");
      const manifest = text === undefined ? undefined : parseManifest(text, undefined);
      // A forge.json that does not parse is the deploy's to report; it declares no schedule, so the rows are dropped.
      syncSchedules(app.db, record.id, st.env, manifest?.ok ? (manifest.value.schedules ?? []) : [], st.commitOid, now());
    }
    dropGoneEnvs(app.db, record.id, live);
  }
}

export function startTimers(app: App, tickMs = 1000): { stop(): void } | undefined {
  if (process.env["NODE_ENV"] === "test") return undefined;
  const reach = runtimeReach(app);
  let firing = false;
  let syncing = false;
  let last = 0;
  // One pass: fire what is due, and once a minute read what the commits declare. A pass still running is not doubled.
  const cycle = async (): Promise<void> => {
    // Before the apps runtime is up a due timer would only burn an attempt: it waits, a row, for the next tick.
    if (appsRuntime(app) === undefined) return;
    if (!syncing && Date.now() - last >= 60_000) {
      syncing = true;
      last = Date.now();
      void syncAll(app).catch((e) => app.log.warn("timers: could not read schedules", { error: String(e) })).finally(() => (syncing = false));
    }
    if (firing) return;
    firing = true;
    try {
      await fireDueTimers(app.db, reach);
    } finally {
      firing = false;
    }
  };
  const tick = setInterval(() => void during("timers", cycle).catch((e) => app.log.warn("timers: could not fire", { error: String(e) })), tickMs);
  tick.unref();
  return { stop: () => clearInterval(tick) };
}
