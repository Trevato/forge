/**
 * Host dispatch for hosted children: a request whose Host is
 * `<name>--<parentHost>` is answered by that child's own App (data under
 * `children/<bodyId>`), not the parent's pages. The ledger is the source of
 * truth; BodyStore is only for placement capacity.
 */

import { childDirOf } from "../actions/spawn.ts";
import { createApp, type App } from "../app.ts";
import { appsRuntime, type AppsRuntime } from "../apps/runtime.ts";
import { resolveAppHost, type AppSocket, type AppTarget } from "../apps/proxy.ts";
import { childAppsSummary, startChildApps, stopChildApps } from "./child-apps.ts";
import { childHost } from "./door.ts";
import { markHostedChild } from "./hosted-mark.ts";
import { firstBoot } from "./first-boot.ts";
import {
  childHostSuffix,
  childPublicUrl,
  CHILD_NAME,
  parentOrigin,
  parseHostedChildAppLabel,
  parseHostedChildName,
  type PlacementKind,
} from "./placement.ts";
import { DEFAULT_SIZE, isSize, type Size } from "./sizes.ts";
import { cellChildren, forward, forwardSocket, type CellChild } from "./cell.ts";
import { cellsAvailable } from "../apps/contain.ts";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ChildLedger {
  readonly name: string;
  readonly bodyId: string;
  readonly done: boolean;
  readonly placement: PlacementKind;
  readonly size: Size;
}

function readLedgerSync(app: App, name: string): ChildLedger | undefined {
  try {
    const raw = readFileSync(join(app.config.dataDir, "spawn", `${name}.json`), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      bodyId?: unknown;
      done?: unknown;
      placement?: unknown;
      size?: unknown;
    };
    if (typeof parsed.name !== "string" || typeof parsed.bodyId !== "string") return undefined;
    return {
      name: parsed.name,
      bodyId: parsed.bodyId,
      done: parsed.done === true,
      placement: parsed.placement === "cell" ? "cell" : "hosted",
      size: isSize(parsed.size) ? parsed.size : DEFAULT_SIZE,
    };
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

/** Who wants to hear that one of a parent's hosted children is closing. */
const closeWatchers = new WeakMap<App, Set<(child: App) => void>>();

/**
 * Call `onClose(child)` for each hosted child of `parent` as it is closed,
 * before its database closes: what holds something per child (its hook
 * listener in `http/server.ts`) lets go of it there. Returns the unwatch.
 */
export function watchHostedChildClose(parent: App, onClose: (child: App) => void): () => void {
  let set = closeWatchers.get(parent);
  if (!set) closeWatchers.set(parent, (set = new Set()));
  set.add(onClose);
  return () => {
    set.delete(onClose);
  };
}

/** Whether `child` is the App this parent has open for it now (not one closed since). */
export function hostedChildOpen(parent: App, child: App): boolean {
  for (const open of caches.get(parent)?.values() ?? []) if (open === child) return true;
  return false;
}

/** Drop every hosted child App this parent has open (call when the parent stops). */
export function closeHostedChildren(parent: App): void {
  const m = caches.get(parent);
  if (!m) return;
  const children = [...m.values()];
  m.clear();
  caches.delete(parent);
  // What holds something per child lets go first, while its database is open.
  for (const child of children) {
    for (const onClose of closeWatchers.get(parent) ?? []) {
      try {
        onClose(child);
      } catch (error) {
        parent.log.warn("a hosted child's close watcher failed", { error: String(error) });
      }
    }
  }
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
  markHostedChild(child);
  await firstBoot(child);
  // Its apps run in this process's lanes, awake before the first visit.
  await startChildApps(parent, child, ledger.name);
  return child;
}

/**
 * Resolve a request Host to a hosted child's App.
 * - `undefined` — not a child host (parent / app / other continues).
 * - `"unknown"` — shaped like a child host but no finished ledger.
 * - `"cell"` — a process of its own: `answerFromCell` carries the request.
 * - `App` — answer with this child's routes.
 */
export async function resolveHostedChild(
  parent: App,
  request: Request,
): Promise<App | "cell" | "unknown" | undefined> {
  const host = request.headers.get("host");
  if (host === null) return undefined;
  const name = parseHostedChildName(host, childHost(parent));
  if (name === undefined) return undefined;
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return "unknown";
  // A child in its own cell is not an App here: the request is carried to
  // it, and while its cell is not up `answerFromCell` says so at once.
  if (ledger.placement === "cell") {
    if (cellChildren(parent).get(ledger.bodyId) !== undefined) return "cell";
    // A host that holds no cell at all is known without waiting.
    const cells = await cellsAvailable();
    if (!cells.ok) return openOnce(parent, demoted(parent, ledger, cells.reason));
    void settleCell(parent, ledger);
    return "cell";
  }
  return openOnce(parent, ledger);
}

/** Starts in flight, by body id: one demotion however many requests asked. */
const settling = new WeakMap<App, Map<string, Promise<CellChild | undefined>>>();

/**
 * Start a child's cell. When the cell cannot come up the child is not left
 * dead: the ledger turns it hosted and says why (`placementNote`, which
 * `/forges` lists), and the next request opens it in this process.
 */
function settleCell(parent: App, ledger: ChildLedger): Promise<CellChild | undefined> {
  let flights = settling.get(parent);
  if (!flights) settling.set(parent, (flights = new Map()));
  let flight = flights.get(ledger.bodyId);
  if (!flight) {
    const cells = cellChildren(parent);
    flight = cells.start(ledger).then((child) => {
      if (child === undefined) demoted(parent, ledger, cells.failure(ledger.bodyId) ?? "its cell did not start");
      return child;
    });
    const mine = flights;
    flight.finally(() => mine.delete(ledger.bodyId)).catch(() => {});
    flights.set(ledger.bodyId, flight);
  }
  return flight;
}

/** Record that a cell child is hosted instead, and why; the ledger as it now reads. */
function demoted(parent: App, ledger: ChildLedger, why: string): ChildLedger {
  demote(parent, ledger.name, why);
  parent.log.warn("child forge placed hosted instead", { name: ledger.name, why });
  return { ...ledger, placement: "hosted" };
}

function demote(parent: App, name: string, why: string): void {
  const path = join(parent.config.dataDir, "spawn", `${name}.json`);
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...raw, placement: "hosted", placementNote: `hosted: ${why}` }));
    renameSync(`${path}.tmp`, path);
  } catch (error) {
    parent.log.error("could not record the placement", { name, error: String(error) });
  }
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
  let ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return;
  if (ledger.placement === "cell") {
    if ((await settleCell(parent, ledger)) !== undefined) return;
    ledger = { ...ledger, placement: "hosted" };
  }
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

/** A child app in a child's own cell: its runtime is in that process, so the request is carried there. */
export interface CellAppHit {
  readonly cell: string;
}

/**
 * The child app a Host names, `"unknown"` when it is shaped like one of a
 * child that exists but names no app of it, undefined when it is no child
 * app's host. The child is whichever `--` split leaves a finished ledger.
 */
export async function resolveHostedChildApp(
  parent: App,
  request: Request,
): Promise<ChildAppHit | CellAppHit | "unknown" | undefined> {
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
    if (ledger.placement === "cell") return { cell: name };
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

/**
 * Answer a request for a child that runs in its own cell: forward when it
 * is up, and when it is not (just spawned, a parent that restarted, a
 * child that stopped) start it and answer 503 at once.
 */
export async function answerFromCell(parent: App, request: Request, named?: string): Promise<Response> {
  const name = named ?? parseHostedChildName(request.headers.get("host") ?? "", childHost(parent));
  const ledger = name === undefined ? undefined : readLedgerSync(parent, name);
  if (ledger === undefined || ledger.placement !== "cell") return new Response("not found", { status: 404 });
  const child = cellChildren(parent).get(ledger.bodyId);
  if (child !== undefined) return forward(child, request, parent.config.clientIpHeader);
  // Never a wait on a cell that may not come up: it starts behind this
  // answer, and once it has failed the ledger says hosted.
  void settleCell(parent, ledger);
  return new Response("this forge is starting", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
}

/**
 * A websocket handshake for a child in its own cell (its home or one of its
 * apps): carried to the cell like any request. `undefined` means it became a
 * socket; while the cell is not up the answer is 503, as for a page.
 */
export async function socketToCell(
  parent: App,
  request: Request,
  server: Bun.Server<AppSocket>,
  named?: string,
): Promise<Response | undefined> {
  const name = named ?? parseHostedChildName(request.headers.get("host") ?? "", childHost(parent));
  const ledger = name === undefined ? undefined : readLedgerSync(parent, name);
  if (ledger === undefined || ledger.placement !== "cell") return new Response("not found", { status: 404 });
  const child = cellChildren(parent).get(ledger.bodyId);
  if (child !== undefined) return forwardSocket(child, request, server, parent.db, parent.config.clientIpHeader);
  void settleCell(parent, ledger);
  return new Response("this forge is starting", { status: 503, headers: { "retry-after": "5", "cache-control": "no-store" } });
}
