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
import { cellChildren, forward, forwardSocket, nextRunDue, type CellChild } from "./cell.ts";
import { cellsAvailable } from "../apps/contain.ts";
import { childNeedsOwnFilesystem } from "../core/capacity.ts";
import { liveChildDisk, startRefusal } from "./disk_mount.ts";
import { floorRefusal } from "./disk_floor.ts";
import { limitValue } from "../settings/limits.ts";
import { awakeRefusal, idleAfterMs, WakeRate } from "./sleep.ts";
import { wakingResponse } from "../web/pages/waking.ts";
import { lapsedResponse, payAgainRoute, PAY_AGAIN_PATH } from "../web/pages/lapsed.ts";
import { lapseFor, type Lapse } from "../billing/lapse.ts";
import { takeDoor } from "../http/strangers.ts";
import { vouched } from "./vouch.ts";
import { during } from "../perf/jobs.ts";
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
  // A cell asleep with a run paused on a limit wakes when that run falls due (#11566).
  for (const name of cellsAsleep) {
    const ledger = readLedgerSync(parent, name);
    const due = ledger === undefined ? undefined : nextRunDue(childDirOf(parent, ledger.bodyId));
    if (ledger !== undefined && due !== undefined) wakeWhenDue(parent, ledger, due, now);
  }
  asleep.push(...cellsAsleep);
  for (const name of asleep) parent.log.info("child forge asleep", { name });
  return asleep;
}

/** Wakes armed for cell children asleep with a run paused on a limit, by body id. */
const dueWakes = new WeakMap<App, Map<string, ReturnType<typeof setTimeout>>>();
/** A due wake the awake ceiling or the disk floor turned away is tried again this much later, ms. */
const DUE_RETRY_MS = 60_000;
/** The longest a timer waits in one step (setTimeout's own limit); a longer wait is armed again. */
const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * Arm a wake for a cell child put to sleep while a run of its crew is paused
 * on a limit (`not_before`, `nextRunDue`): at `at` its cell starts and the
 * child's dispatcher starts the run, so a paused run does not wait for a
 * visitor. The wake keeps the host's limits: never while its billing is
 * `none` or when it is already awake; at the awake ceiling or below the disk
 * floor it is tried again `DUE_RETRY_MS` later. One per child: arming again
 * replaces it.
 */
function wakeWhenDue(parent: App, ledger: ChildLedger, at: number, now = Date.now()): void {
  let wakes = dueWakes.get(parent);
  if (!wakes) dueWakes.set(parent, (wakes = new Map()));
  const was = wakes.get(ledger.bodyId);
  if (was !== undefined) clearTimeout(was);
  const mine = wakes;
  const timer = setTimeout(() => {
    if (mine.get(ledger.bodyId) === timer) mine.delete(ledger.bodyId);
    if (Date.now() < at) return wakeWhenDue(parent, ledger, at);
    void wakeDue(parent, ledger.name).catch((error: unknown) =>
      parent.log.warn("child forge not woken for its run", { name: ledger.name, error: String(error) }),
    );
  }, Math.min(TIMER_MAX_MS, Math.max(0, at - now)));
  timer.unref?.();
  wakes.set(ledger.bodyId, timer);
}

async function wakeDue(parent: App, name: string): Promise<void> {
  // Read again: since it slept the child may have been woken, demoted to hosted, lapsed or removed.
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done || ledger.placement !== "cell") return;
  if (isAwakeBody(parent, ledger.bodyId) || lapsedNone(parent, name) !== undefined) return;
  if (floorRefusal(parent.config.dataDir) !== undefined || awakeRefusal(awakeCount(parent)) !== undefined) {
    wakeWhenDue(parent, ledger, Date.now() + DUE_RETRY_MS);
    return;
  }
  if (startRefused(parent, ledger) !== undefined) return;
  keepSweeping(parent);
  keepWatchingFloor(parent);
  touch(parent, ledger);
  parent.log.info("child forge woken for a run due", { name });
  await settleCell(parent, ledger);
}

/**
 * Below the disk floor (`spawn/disk_floor.ts`) no child forge stays awake:
 * every hosted child closes and every cell stops, busy or not, so nothing
 * they write takes the parent's last room. Their data stays on disk; the
 * wake gate keeps them asleep, answering the floor's one line, until room
 * is made (#10873). Answers the names put to sleep; none when above it.
 */
export async function sleepBelowFloor(parent: App): Promise<string[]> {
  const floor = floorRefusal(parent.config.dataDir);
  if (floor === undefined) return [];
  const asleep: string[] = [];
  const cache = caches.get(parent);
  for (const [bodyId, child] of [...(cache ?? [])])
    asleep.push(await closeOne(parent, cache!, bodyId, child, touched.get(parent)?.get(bodyId)?.name ?? bodyId));
  const cells = cellChildren(parent);
  for (const child of [...cells.list()]) {
    touched.get(parent)?.delete(child.bodyId);
    waking.get(parent)?.delete(child.bodyId);
    await cells.stop(child.bodyId);
    asleep.push(child.name);
  }
  for (const name of asleep) parent.log.warn("child forge asleep", { name, why: floor });
  return asleep;
}

/** How often the floor is looked at while children may be awake, ms. */
export const FLOOR_EVERY_MS = 30_000;
const floorWatchers = new WeakMap<App, ReturnType<typeof setInterval>>();

function keepWatchingFloor(parent: App): void {
  if (floorWatchers.has(parent)) return;
  const timer = setInterval(() => void during("spawn-floor", () => sleepBelowFloor(parent)).catch(() => {}), FLOOR_EVERY_MS);
  timer.unref?.();
  floorWatchers.set(parent, timer);
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

/** A child's lapse when its billing is `none`: it sleeps and does not wake until paid (#11393); else undefined. */
export function lapsedNone(parent: App, name: string): Extract<Lapse, { state: "none" }> | undefined {
  const lapse = lapseFor(parent.db, name);
  return lapse.state === "none" ? lapse : undefined;
}

/** Put to sleep, through `sleepChild`, every awake child whose billing is `none`. Answers the names. */
export async function sleepLapsed(parent: App): Promise<string[]> {
  const names = new Set<string>([...(touched.get(parent)?.values() ?? [])].map((m) => m.name));
  for (const c of cellChildren(parent).list()) names.add(c.name);
  const asleep: string[] = [];
  for (const name of names) {
    if (lapsedNone(parent, name) === undefined || !(await sleepChild(parent, name))) continue;
    parent.log.warn("child forge asleep", { name, why: "billing is none" });
    asleep.push(name);
  }
  return asleep;
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
  const timer = setInterval(() => void during("spawn-idle", async () => {
    await sleepLapsed(parent);
    await sleepIdleChildren(parent);
  }).catch(() => {}), every);
  timer.unref?.();
  sweepers.set(parent, timer);
}

/** Whether the child itself vouches for the request's session or token: a header a client merely wrote is not enough. */
const carriesCredentials = (parent: App, bodyId: string, request: Request): boolean =>
  vouched(childDirOf(parent, bodyId), request, caches.get(parent)?.get(bodyId)?.db);

/**
 * Why the child `ledger` names may not start now, in one plain line;
 * undefined when it may. Only `children.ownFilesystem` refuses: a child whose
 * data is not a filesystem of its own. The setting is read first, so with it
 * off a start costs no mountinfo read.
 */
export function startRefused(parent: App, ledger: { readonly name: string; readonly bodyId: string }): string | undefined {
  // Below the disk floor nothing wakes, whatever its filesystem (#10873).
  const floor = floorRefusal(parent.config.dataDir);
  if (floor !== undefined) {
    parent.log.warn("child forge not started", { name: ledger.name, why: floor });
    return floor;
  }
  if (!childNeedsOwnFilesystem(parent.db)) return undefined;
  const why = startRefusal(ledger.name, liveChildDisk(parent.config.dataDir, ledger.bodyId), true);
  if (why !== undefined) parent.log.warn("child forge not started", { name: ledger.name, why });
  return why;
}

/** The answer to a request for a child that may not start: the line, as text, 503. */
export function refusedResponse(why: string): Response {
  return new Response(`${why}\n`, {
    status: 503,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

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
  keepWatchingFloor(parent);
  // Below the disk floor an awake child is put to sleep now, not at the next look,
  // and this request is answered with why: it writes nothing (#10873).
  const floor = floorRefusal(parent.config.dataDir);
  if (floor !== undefined) {
    if (isAwakeBody(parent, ledger.bodyId)) void sleepChild(parent, name).catch(() => {});
    return refusedResponse(floor);
  }
  // Billing `none`: asleep now and answered with why, never woken until paid (#11393).
  const lapsed = lapsedNone(parent, name);
  if (lapsed !== undefined) {
    if (isAwakeBody(parent, ledger.bodyId)) void sleepChild(parent, name).catch(() => {});
    return lapsedResponse(parent, request, name, lapsed);
  }
  const known = carriesCredentials(parent, ledger.bodyId, request);
  if (isAwakeBody(parent, ledger.bodyId)) {
    if (known) {
      bootOpened.get(parent)?.delete(ledger.bodyId);
      touch(parent, ledger);
      cellChildren(parent).touch(ledger.bodyId);
    }
    return undefined;
  }
  // Asleep, so answering would start it: not where it has no filesystem of its own and one is required.
  const refused = startRefused(parent, ledger);
  if (refused !== undefined) return refusedResponse(refused);
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

/** POST to a lapsed forge's address: the button to pay again. Undefined for anything else. */
export async function payAgainGate(parent: App, request: Request): Promise<Response | undefined> {
  if (request.method !== "POST" || new URL(request.url).pathname !== PAY_AGAIN_PATH) return undefined;
  const name = parseHostedChildName(request.headers.get("host") ?? "", childHost(parent));
  if (name === undefined) return undefined;
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done || lapsedNone(parent, name) === undefined) return undefined;
  return payAgainRoute(parent, request, name);
}

/** Drop every hosted child App this parent has open (call when the parent stops). */
export function closeHostedChildren(parent: App): void {
  const sweeper = sweepers.get(parent);
  if (sweeper !== undefined) clearInterval(sweeper);
  sweepers.delete(parent);
  const watcher = floorWatchers.get(parent);
  if (watcher !== undefined) clearInterval(watcher);
  floorWatchers.delete(parent);
  touched.delete(parent);
  bootOpened.delete(parent);
  waking.delete(parent);
  inFlight.delete(parent);
  for (const timer of dueWakes.get(parent)?.values() ?? []) clearTimeout(timer);
  dueWakes.delete(parent);
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
  if (!isAwakeBody(parent, ledger.bodyId) && startRefused(parent, ledger) !== undefined) return;
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
  keepWatchingFloor(parent);
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

/** A child app whose forge may not start (`startRefused`): the line it is answered with. */
export interface RefusedHit {
  readonly refused: string;
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
): Promise<ChildAppHit | CellAppHit | RefusedHit | "unknown" | undefined> {
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
    // Billing `none`: its apps do not answer, awake or not, until paid (#11393).
    if (lapsedNone(parent, name) !== undefined) {
      if (isAwakeBody(parent, ledger.bodyId)) void sleepChild(parent, name).catch(() => {});
      return { refused: `${name} is asleep because its subscription ended and was not paid again` };
    }
    if (!isAwakeBody(parent, ledger.bodyId)) {
      const refused = startRefused(parent, ledger);
      if (refused !== undefined) return { refused };
    }
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
  // Asleep: it wakes behind this answer. Every request, a form's POST included, is
  // held until the cell is up (wakeLimits.waitMs) so a submit is never lost; only a wake
  // that takes longer is answered with the "waking up" page, which tries again by itself.
  const starting = settleCell(parent, ledger);
  // Only so many wait on one cell: the rest are told it is waking at once, so a crowd cannot pin connections and bodies.
  const waiting = waiters.get(ledger.bodyId) ?? 0;
  if (waiting >= wakeLimits.waiters) return wakingResponse(parent, request, ledger.name);
  waiters.set(ledger.bodyId, waiting + 1);
  let woke: CellChild | undefined;
  try {
    woke = await Promise.race([starting, Bun.sleep(wakeLimits.waitMs).then(() => undefined)]);
  } finally {
    const left = (waiters.get(ledger.bodyId) ?? 1) - 1;
    if (left <= 0) waiters.delete(ledger.bodyId);
    else waiters.set(ledger.bodyId, left);
  }
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

/** How long a request waits for a sleeping cell forge before it is told it is waking, and how many may wait on one cell. */
export const wakeLimits = { waitMs: 20_000, waiters: 16 };

/** Requests held for a waking cell now, by body id. */
const waiters = new Map<string, number>();

/** How many requests wait on this cell's wake now. */
export const waitingFor = (bodyId: string): number => waiters.get(bodyId) ?? 0;

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
