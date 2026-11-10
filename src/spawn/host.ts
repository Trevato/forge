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
import { childAppsSummary, startChildApps, stopChildApps, stopChildAppsOf } from "./child-apps.ts";
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
import { limitValue } from "../settings/limits.ts";
import { awakeRefusal, idleAfterMs, WakeRate } from "./sleep.ts";
import { wakingResponse } from "../web/pages/waking.ts";
import { takeDoor } from "../http/strangers.ts";
import { vouched } from "./vouch.ts";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface ChildLedger {
  readonly name: string;
  readonly bodyId: string;
  readonly ownerId: string | undefined;
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
      ownerId?: unknown;
      done?: unknown;
      placement?: unknown;
      size?: unknown;
    };
    if (typeof parsed.name !== "string" || typeof parsed.bodyId !== "string") return undefined;
    return {
      name: parsed.name,
      bodyId: parsed.bodyId,
      ownerId: typeof parsed.ownerId === "string" ? parsed.ownerId : undefined,
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

/** When a request last reached each open hosted child, by body id, with the name it goes by. */
const touched = new WeakMap<App, Map<string, { name: string; at: number }>>();
const wakeRates = new WeakMap<App, WakeRate>();
const personWakes = new WeakMap<App, WakeRate>();
/** A clock the gate reads; a test sets it to a fake. */
export const gateClock = { now: () => Date.now() };
const sweepers = new WeakMap<App, ReturnType<typeof setInterval>>();

function touch(parent: App, ledger: { bodyId: string; name: string }, now = Date.now()): void {
  let m = touched.get(parent);
  if (!m) touched.set(parent, (m = new Map()));
  m.set(ledger.bodyId, { name: ledger.name, at: now });
}

/** Forges awake now: hosted children open in this process plus children running in a cell. */
export function awakeCount(parent: App): number {
  // A child boot opened and nobody has asked for is not in use: it never crowds out a person's wake.
  const unasked = bootOpened.get(parent)?.size ?? 0;
  const awake = Math.max(0, (caches.get(parent)?.size ?? 0) - unasked) + cellChildren(parent).list().length;
  // A wake granted but not finished holds its slot, so two at once cannot both pass the ceiling.
  return awake + reservedCount(parent);
}

/** Hosted children the boot opened that no request has reached since, by body id. */
const bootOpened = new WeakMap<App, Set<string>>();

/** Wakes granted and not yet awake, by body id, with when. */
const waking = new WeakMap<App, Map<string, number>>();
const RESERVE_MS = 30_000;

function reservedCount(parent: App, now = Date.now()): number {
  const m = waking.get(parent);
  if (!m) return 0;
  let n = 0;
  for (const [bodyId, at] of [...m]) {
    if (now - at >= RESERVE_MS || isAwakeBody(parent, bodyId)) m.delete(bodyId);
    else n++;
  }
  return n;
}

const isAwakeBody = (parent: App, bodyId: string): boolean =>
  caches.get(parent)?.has(bodyId) === true || cellChildren(parent).get(bodyId) !== undefined;

/** Requests being answered now, by body id: a forge answering one does not sleep under it. */
const inFlight = new WeakMap<App, Map<string, number>>();

/** Mark a request as under way for this child; the function it answers ends it. */
export function holdChild(parent: App, child: App): () => void {
  const m = inFlight.get(parent) ?? new Map<string, number>();
  inFlight.set(parent, m);
  const key = child.config.dataDir;
  m.set(key, (m.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    const left = (m.get(key) ?? 1) - 1;
    if (left <= 0) m.delete(key);
    else m.set(key, left);
  };
}

/** Whether the child is mid-request or has crew work queued or running: it is not idle however quiet its visitors. */
function working(parent: App, child: App): boolean {
  if ((inFlight.get(parent)?.get(child.config.dataDir) ?? 0) > 0) return true;
  try {
    return child.db.query("SELECT 1 FROM run WHERE state IN ('queued','running') LIMIT 1").get() !== null;
  } catch {
    return false;
  }
}

/**
 * Put to sleep every child quiet for `idleMs`: a hosted child's apps stop and its App
 * closes, a cell child's process stops. Their data stays on disk; the next request
 * wakes them. Answers the names put to sleep.
 */
export async function sleepIdleChildren(parent: App, idleMs = idleAfterMs(), now = Date.now()): Promise<string[]> {
  const asleep: string[] = [];
  const cache = caches.get(parent);
  for (const [bodyId, child] of [...(cache ?? [])]) {
    const mark = touched.get(parent)?.get(bodyId);
    if (mark === undefined || now - mark.at < idleMs || working(parent, child)) continue;
    asleep.push(await closeOne(parent, cache!, bodyId, child, mark.name));
  }
  const cellsAsleep = await cellChildren(parent).sleepIdle(idleMs, now);
  for (const [bodyId, mark] of [...(touched.get(parent) ?? [])]) if (cellsAsleep.includes(mark.name)) {
    touched.get(parent)?.delete(bodyId);
    waking.get(parent)?.delete(bodyId);
  }
  asleep.push(...cellsAsleep);
  for (const name of asleep) parent.log.info("child forge asleep", { name });
  return asleep;
}

/** Put one named child to sleep now (its owner stopped it); true when it was awake. */
export async function sleepChild(parent: App, name: string): Promise<boolean> {
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined) return false;
  const cache = caches.get(parent);
  const child = cache?.get(ledger.bodyId);
  if (cache !== undefined && child !== undefined) {
    await closeOne(parent, cache, ledger.bodyId, child, name);
    return true;
  }
  if (cellChildren(parent).get(ledger.bodyId) === undefined) return false;
  touched.get(parent)?.delete(ledger.bodyId);
  waking.get(parent)?.delete(ledger.bodyId);
  await cellChildren(parent).stop(ledger.bodyId);
  return true;
}

/** Whether a child is awake: open in this process or running in a cell. */
export function childAwake(parent: App, name: string): boolean {
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined) return false;
  return caches.get(parent)?.has(ledger.bodyId) === true || cellChildren(parent).get(ledger.bodyId) !== undefined;
}

async function closeOne(parent: App, cache: Map<string, App>, bodyId: string, child: App, name: string): Promise<string> {
  cache.delete(bodyId);
  bootOpened.get(parent)?.delete(bodyId);
  touched.get(parent)?.delete(bodyId);
  waking.get(parent)?.delete(bodyId);
  for (const onClose of closeWatchers.get(parent) ?? []) {
    try {
      onClose(child);
    } catch (error) {
      parent.log.warn("a hosted child's close watcher failed", { error: String(error) });
    }
  }
  await stopChildAppsOf(parent, name).catch(() => {});
  child.close();
  return name;
}

function keepSweeping(parent: App): void {
  if (sweepers.has(parent)) return;
  const every = Math.max(1000, Math.min(60_000, Math.floor(idleAfterMs() / 4)));
  const timer = setInterval(() => void sleepIdleChildren(parent).catch(() => {}), every);
  timer.unref?.();
  sweepers.set(parent, timer);
}

/** Whether the child itself vouches for the request's session or token: a header a client merely wrote is not enough. */
const carriesCredentials = (parent: App, bodyId: string, request: Request): boolean =>
  vouched(childDirOf(parent, bodyId), request, caches.get(parent)?.get(bodyId)?.db);

/**
 * Before a child's Host is answered: a child already awake is marked busy (by a
 * request whose session or token the child verifies, so a stranger cannot keep it awake); one
 * asleep is woken within the limits (a stranger's address first, then this host's
 * awake ceiling, then, for strangers, the child's wakes an hour), else a plain
 * refusal. The slot is reserved here. Undefined means carry on.
 */
export function wakeGate(parent: App, request: Request): Response | undefined {
  const name = parseHostedChildName(request.headers.get("host") ?? "", childHost(parent));
  if (name === undefined) return undefined;
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return undefined;
  keepSweeping(parent);
  const known = carriesCredentials(parent, ledger.bodyId, request);
  if (isAwakeBody(parent, ledger.bodyId)) {
    if (known) {
      bootOpened.get(parent)?.delete(ledger.bodyId);
      touch(parent, ledger);
      cellChildren(parent).touch(ledger.bodyId);
    }
    return undefined;
  }
  // A wake already granted (a cell takes a moment to answer) is one wake, not one per request.
  let reserved = waking.get(parent);
  if (!reserved) waking.set(parent, (reserved = new Map()));
  if (reservedCount(parent) > 0 && reserved.has(ledger.bodyId)) return undefined;
  const verdict = takeDoor(parent, "api", request);
  if (!verdict.allowed) return wakingResponse(parent, request, name, "too many requests to sleeping forges from your address; try again in a minute");
  let rates = wakeRates.get(parent);
  if (!rates) wakeRates.set(parent, (rates = new WakeRate()));
  const at = gateClock.now();
  let people = personWakes.get(parent);
  if (!people) personWakes.set(parent, (people = new WakeRate()));
  const wait = ledger.ownerId === undefined ? 0 : people.waitS(ledger.ownerId, limitValue(parent.db, "forges.wakes_per_person_hour"), at);
  if (wait > 0) return wakingResponse(parent, request, name, `waking too often, try in ${wait} s`, wait);
  const why = awakeRefusal(awakeCount(parent)) ?? (known ? undefined : rates.refusal(ledger.bodyId, at));
  if (why !== undefined) return wakingResponse(parent, request, name, why);
  if (!known) rates.note(ledger.bodyId, at);
  if (ledger.ownerId !== undefined) people.note(ledger.ownerId, at);
  reserved.set(ledger.bodyId, Date.now());
  touch(parent, ledger);
  return undefined;
}

/** Drop every hosted child App this parent has open (call when the parent stops). */
export function closeHostedChildren(parent: App): void {
  const sweeper = sweepers.get(parent);
  if (sweeper !== undefined) clearInterval(sweeper);
  sweepers.delete(parent);
  touched.delete(parent);
  bootOpened.delete(parent);
  waking.delete(parent);
  inFlight.delete(parent);
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
  markHostedChild(child, parent.config.dataDir);
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
      touch(parent, ledger);
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
    const ledger = readLedgerSync(parent, name);
    const was = ledger !== undefined && caches.get(parent)?.has(ledger.bodyId) === true;
    await bootHostedChild(parent, name);
    if (ledger !== undefined && !was && caches.get(parent)?.has(ledger.bodyId) === true) {
      let set = bootOpened.get(parent);
      if (!set) bootOpened.set(parent, (set = new Set()));
      set.add(ledger.bodyId);
    }
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
  const cells = cellChildren(parent);
  const child = cells.get(ledger.bodyId);
  if (child !== undefined) {
    const release = cells.hold(ledger.bodyId);
    try {
      return await forward(child, request, parent.config.clientIpHeader);
    } finally {
      release();
    }
  }
  // Asleep: it wakes behind this answer. A git push or an API call waits a few
  // seconds for it; a page, or a wake that takes longer, is a plain "waking up" page.
  // A page never waits: it starts the cell and gets the waking page at once.
  const path = new URL(request.url).pathname;
  const patient = path.startsWith("/api/") || path.includes(".git/");
  const starting = settleCell(parent, ledger);
  const woke = patient ? await Promise.race([starting, Bun.sleep(WAKE_WAIT_MS).then(() => undefined)]) : undefined;
  if (woke !== undefined) {
    const release = cells.hold(ledger.bodyId);
    try {
      return await forward(woke, request, parent.config.clientIpHeader);
    } finally {
      release();
    }
  }
  return wakingResponse(parent, request, ledger.name);
}

/** How long a request waits for a sleeping cell forge before it is told it is waking. */
const WAKE_WAIT_MS = 4000;

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
