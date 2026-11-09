/**
 * A hosted child's apps. The child is a second `createApp` in this process
 * (`spawn/host.ts`); this gives it what the parent has for its own apps —
 * an `AppsRuntime` over the child's repos, data and secrets (all under the
 * child's own data directory) and a checks service — and attaches both to
 * the parent's capacity: the child's deploys wait at the parent's runtime
 * gate and its checks at the parent's checks gate, so a child is one more
 * tenant of the same lanes, not a free pass. Its apps answer at
 * `<app>--<child>--<parentHost>`, one label under the platform apex.
 */

import type { App } from "../app.ts";
import { startChecks, checksFor, type ChecksHandle } from "../checks/service.ts";
import { listApps } from "../core/apps.ts";
import { appsRuntime, AppsRuntime } from "../apps/runtime.ts";
import { childHost } from "./door.ts";
import { childPublicUrl, parentOrigin } from "./placement.ts";

interface Running {
  readonly child: App;
  readonly runtime: AppsRuntime;
  readonly checks: ChecksHandle | undefined;
}

const running = new WeakMap<App, Map<string, Running>>();

/** The runtime serving this child's apps, if the parent runs apps at all. */
export function childRuntime(parent: App, name: string): AppsRuntime | undefined {
  return running.get(parent)?.get(name)?.runtime;
}

/**
 * Start a child's apps under its parent. Once per child; a parent without
 * an apps service (apps off) starts nothing and the child serves its pages
 * only.
 */
export async function startChildApps(parent: App, child: App, name: string): Promise<void> {
  const own = appsRuntime(parent);
  if (own === undefined) return;
  let held = running.get(parent);
  if (!held) running.set(parent, (held = new Map()));
  if (held.has(name)) return;
  const runtime = new AppsRuntime(child, {
    domain: `--${name}--${childHost(parent)}`,
    scheme: own.options.scheme,
    publicPort: own.options.publicPort,
    forgeUrl: childPublicUrl(name, parentOrigin(parent.config)),
    gate: own.lane,
    busyGraceMs: own.options.busyGraceMs,
    idlePullMs: own.options.idlePullMs,
    sleepAfterMs: own.options.sleepAfterMs,
    sweepEveryMs: own.options.sweepEveryMs,
    dns: own.options.dns,
    cloudBody: own.options.cloudBody,
    ownedCapacity: own.options.ownedCapacity,
  });
  // Claimed before the first await: a second request cannot start it twice.
  const parentChecks = checksFor(parent);
  const entry: Running = {
    child,
    runtime,
    checks:
      parentChecks === undefined
        ? undefined
        : startChecks(child, {
            forgeUrl: runtime.options.forgeUrl,
            gate: parentChecks.lane,
            label: name,
          }),
  };
  held.set(name, entry);
  await runtime.start();
}

/** Stop every child's apps and checks (the parent is stopping). */
export async function stopChildApps(parent: App): Promise<void> {
  const held = running.get(parent);
  if (!held) return;
  running.delete(parent);
  for (const { runtime, checks } of held.values()) {
    await checks?.stop();
    await runtime.stop();
  }
}

/** Stop one child's apps and checks (it is going to sleep). */
export async function stopChildAppsOf(parent: App, name: string): Promise<void> {
  const held = running.get(parent);
  const entry = held?.get(name);
  if (!held || !entry) return;
  held.delete(name);
  await entry.checks?.stop();
  await entry.runtime.stop();
}

export interface ChildAppsSummary {
  readonly total: number;
  readonly running: number;
  /** Each app that is not running, and why, in the runtime's own words. */
  readonly notRunning: readonly { readonly slug: string; readonly why: string }[];
}

/** What `/forges` says per child: "3 apps running", or which one is not and why. */
export function childAppsSummary(parent: App, name: string): ChildAppsSummary | undefined {
  const held = running.get(parent)?.get(name);
  if (held === undefined) return undefined;
  const { child, runtime } = held;
  const records = listApps(child.db);
  const notRunning: { slug: string; why: string }[] = [];
  let up = 0;
  for (const record of records) {
    const prod = runtime.status(record).find((s) => s.env === "production");
    if (prod?.state === "running") up++;
    else
      notRunning.push({
        slug: record.slug,
        why: prod === undefined ? "not started" : (prod.error ?? prod.state),
      });
  }
  return { total: records.length, running: up, notRunning };
}
