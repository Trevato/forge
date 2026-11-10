/**
 * What the app families of `GET /metrics` read from a running forge: every
 * app's environments as the runtime already holds them, and the cells the
 * watch has already read. It starts nothing and reads no process.
 */
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { listApps } from "../core/apps.ts";
import { cellCountersFor } from "../spawn/process_counters.ts";
import type { AppSources } from "./forge.ts";

export function appSources(app: App): AppSources {
  const runtime = appsRuntime(app);
  if (runtime === undefined) return { apps: [], cells: [] };
  return {
    apps: listApps(app.db).map((a) => ({
      id: a.id,
      slug: a.slug,
      private: a.access === "private",
      envs: runtime.status(a).map((e) => ({ env: e.env, state: e.state })),
    })),
    cells: cellCountersFor(app),
  };
}
