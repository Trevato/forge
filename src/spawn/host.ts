/**
 * Host dispatch for hosted children: a request whose Host is
 * `<name>--<parentHost>` is answered by that child's own App (data under
 * `children/<bodyId>`), not the parent's pages. The ledger is the source of
 * truth; BodyStore is only for placement capacity.
 */

import { childDirOf } from "../actions/spawn.ts";
import { createApp, type App } from "../app.ts";
import { appsRuntime, type AppsRuntime } from "../apps/runtime.ts";
import { resolveAppHost, type AppTarget } from "../apps/proxy.ts";
import { childAppsSummary, startChildApps, stopChildApps } from "./child-apps.ts";
import { childHost } from "./door.ts";
import { firstBoot } from "./first-boot.ts";
import {
  childHostSuffix,
  childPublicUrl,
  CHILD_NAME,
  parentOrigin,
  parseHostedChildAppLabel,
  parseHostedChildName,
} from "./placement.ts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface ChildLedger {
  readonly name: string;
  readonly bodyId: string;
  readonly done: boolean;
}

function readLedgerSync(app: App, name: string): ChildLedger | undefined {
  try {
    const raw = readFileSync(join(app.config.dataDir, "spawn", `${name}.json`), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      bodyId?: unknown;
      done?: unknown;
    };
    if (typeof parsed.name !== "string" || typeof parsed.bodyId !== "string") return undefined;
    return { name: parsed.name, bodyId: parsed.bodyId, done: parsed.done === true };
  } catch {
    return undefined;
  }
}

const caches = new WeakMap<App, Map<string, App>>();
/** Opens in flight, so two requests for one child open it once. */
const opening = new WeakMap<App, Map<string, Promise<App>>>();

function cacheOf(parent: App): Map<string, App> {
  let m = caches.get(parent);
  if (!m) {
    m = new Map();
    caches.set(parent, m);
  }
  return m;
}

/** Drop every hosted child App this parent has open (call when the parent stops). */
export function closeHostedChildren(parent: App): void {
  const m = caches.get(parent);
  if (!m) return;
  const children = [...m.values()];
  m.clear();
  caches.delete(parent);
  // A child's apps and checks use its database: they stop before it closes.
  void stopChildApps(parent).finally(() => {
    for (const child of children) child.close();
  });
}

async function openChild(parent: App, ledger: ChildLedger): Promise<App> {
  const url = childPublicUrl(ledger.name, parentOrigin(parent.config));
  const child = createApp({
    dataDir: childDirOf(parent, ledger.bodyId),
    url,
    ...(parent.config.trustedProxies !== undefined
      ? { trustedProxies: parent.config.trustedProxies }
      : {}),
    ...(parent.config.clientIpHeader !== undefined
      ? { clientIpHeader: parent.config.clientIpHeader }
      : {}),
  });
  await firstBoot(child);
  // Its apps run in this process's lanes, awake before the first visit.
  await startChildApps(parent, child, ledger.name);
  return child;
}

/**
 * Resolve a request Host to a hosted child's App.
 * - `undefined` — not a child host (parent / app / other continues).
 * - `"unknown"` — shaped like a child host but no finished ledger.
 * - `App` — answer with this child's routes.
 */
export async function resolveHostedChild(
  parent: App,
  request: Request,
): Promise<App | "unknown" | undefined> {
  const host = request.headers.get("host");
  if (host === null) return undefined;
  const name = parseHostedChildName(host, childHost(parent));
  if (name === undefined) return undefined;
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return "unknown";

  return openOnce(parent, ledger);
}

function openOnce(parent: App, ledger: ChildLedger): Promise<App> | App {
  const cache = cacheOf(parent);
  const hit = cache.get(ledger.bodyId);
  if (hit) return hit;
  let flights = opening.get(parent);
  if (!flights) opening.set(parent, (flights = new Map()));
  let flight = flights.get(ledger.bodyId);
  if (!flight) {
    flight = openChild(parent, ledger).then((opened) => {
      cache.set(ledger.bodyId, opened);
      return opened;
    });
    flight.finally(() => flights.delete(ledger.bodyId)).catch(() => {});
    flights.set(ledger.bodyId, flight);
  }
  return flight;
}

/**
 * Open one finished child now, which starts its apps: after a spawn, so
 * the first visit after a claim finds them awake. Never throws.
 */
export async function bootHostedChild(parent: App, name: string): Promise<void> {
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return;
  try {
    await startChildApps(parent, await openOnce(parent, ledger), name);
  } catch (error) {
    parent.log.error("hosted child did not open", { name, error: String(error) });
  }
}

/** Open every finished child, on boot: their apps come back with the parent's. */
export async function bootHostedChildren(parent: App): Promise<void> {
  let files: string[] = [];
  try {
    files = readdirSync(join(parent.config.dataDir, "spawn"));
  } catch {
    return;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -".json".length);
    if (parseHostedChildName(`${name}${childHostSuffix(childHost(parent))}`, childHost(parent)) !== name) continue;
    await bootHostedChild(parent, name);
  }
}

/** A hosted child's app, as a request names it: `<app>--<child>--<parentHost>`. */
export interface ChildAppHit {
  readonly runtime: AppsRuntime;
  readonly target: AppTarget;
}

/**
 * The child app a Host names, `"unknown"` when it is shaped like one of a
 * child that exists but names no app of it, undefined when it is no child
 * app's host. The child is whichever `--` split leaves a finished ledger.
 */
export async function resolveHostedChildApp(
  parent: App,
  request: Request,
): Promise<ChildAppHit | "unknown" | undefined> {
  const host = request.headers.get("host");
  if (host === null) return undefined;
  const label = parseHostedChildAppLabel(host, childHost(parent));
  if (label === undefined) return undefined;
  // A child that is named exactly so is the child itself, not an app of one.
  const own = readLedgerSync(parent, label);
  if (own !== undefined && own.done) return undefined;
  // A child name is at most 38 characters, so only a split that leaves one
  // that short can name a child: the ledger reads are bounded, not per label.
  const from = Math.max(1, label.length - 40);
  for (let i = label.indexOf("--", from - 1); i > 0; i = label.indexOf("--", i + 2)) {
    const name = label.slice(i + 2);
    if (!CHILD_NAME.test(name)) continue;
    const ledger = readLedgerSync(parent, name);
    if (ledger === undefined || !ledger.done) continue;
    const child = await openOnce(parent, ledger);
    const runtime = appsRuntime(child);
    if (runtime === undefined) return "unknown";
    const target = resolveAppHost(child, runtime.options.domain, request);
    if (target === undefined || target === "unknown") return "unknown";
    return { runtime, target };
  }
  return undefined;
}

/** What a child's apps are doing, for `/forges`; undefined when none run here. */
export const hostedChildApps = childAppsSummary;
