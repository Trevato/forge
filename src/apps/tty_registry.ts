/**
 * The app terminals open now (#10549): a plain registry, one entry per
 * open terminal — which app, preview or production, who holds it, when it
 * started, its last input and output. Account sessions list it beside the
 * machine shells; Stop and Stop all idle end it with SIGHUP to its pty; one
 * with no input and no output for the idle limit ends itself.
 *
 * Nothing here knows how a terminal is run: `runAppTty` registers what it
 * started and tells the registry about bytes; the registry holds a hangup.
 */

import type { App } from "../app.ts";

export interface AppTtyEntry {
  readonly id: string;
  /** Null for a guest: listed to no one, but still ended when idle. */
  readonly userId: string | null;
  readonly repository: string;
  readonly slug: string;
  /** `production`, `preview-12`, … */
  readonly env: string;
  readonly startedAt: number;
  lastInput: number;
  lastOutput: number;
  /** The host went away or someone stopped it: SIGHUP to the pty and its group. */
  readonly hangup: () => void;
  ended: boolean;
  timer: ReturnType<typeof setInterval>;
}

const registries = new WeakMap<App, Map<string, AppTtyEntry>>();

function entriesOf(app: App): Map<string, AppTtyEntry> {
  let map = registries.get(app);
  if (map === undefined) registries.set(app, (map = new Map()));
  return map;
}

export interface AppTtyHandle {
  readonly id: string;
  input(): void;
  output(): void;
  /** The terminal ended by itself: forget it. */
  close(): void;
}

export interface OpenAppTty {
  readonly userId: string | undefined;
  readonly repository: string;
  readonly slug: string;
  readonly env: string;
  readonly hangup: () => void;
  /** The idle limit in ms, read at every check. */
  readonly idleMs: () => number;
  readonly checkMs?: number;
}

export const CHECK_MS = 5_000;

export function idleFor(e: { lastInput: number; lastOutput: number }, limitMs: number, now = Date.now()): boolean {
  return now - e.lastInput >= limitMs && now - e.lastOutput >= limitMs;
}

/** Register an open app terminal. */
export function openAppTty(app: App, open: OpenAppTty): AppTtyHandle {
  const now = Date.now();
  const entry: AppTtyEntry = {
    id: `app-${crypto.randomUUID()}`,
    userId: open.userId ?? null,
    repository: open.repository,
    slug: open.slug,
    env: open.env,
    startedAt: now,
    lastInput: now,
    lastOutput: now,
    hangup: open.hangup,
    ended: false,
    timer: setInterval(
      () => {
        if (idleFor(entry, open.idleMs())) stop(app, entry);
      },
      Math.max(10, Math.min(open.idleMs(), open.checkMs ?? CHECK_MS)),
    ),
  };
  entriesOf(app).set(entry.id, entry);
  return {
    id: entry.id,
    input: () => void (entry.lastInput = Date.now()),
    output: () => void (entry.lastOutput = Date.now()),
    close: () => forget(app, entry),
  };
}

function forget(app: App, entry: AppTtyEntry): void {
  entry.ended = true;
  clearInterval(entry.timer);
  entriesOf(app).delete(entry.id);
}

function stop(app: App, entry: AppTtyEntry): void {
  if (entry.ended) return;
  forget(app, entry);
  entry.hangup();
}

/** The app terminals a person holds, newest first. */
export function appTtysOf(app: App, userId: string): AppTtyEntry[] {
  return [...entriesOf(app).values()].filter((e) => e.userId === userId).sort((a, b) => b.startedAt - a.startedAt);
}

/** Stop one app terminal a person holds: false when they hold no such one. */
export function stopAppTty(app: App, userId: string, id: string): boolean {
  const entry = entriesOf(app).get(id);
  if (entry === undefined || entry.userId !== userId) return false;
  stop(app, entry);
  return true;
}

/** Stop every app terminal of a person's past half the idle limit; returns how many. */
export function stopIdleAppTtys(app: App, userId: string, idleMs: number): number {
  let n = 0;
  for (const e of appTtysOf(app, userId)) {
    if (!idleFor(e, idleMs / 2)) continue;
    stop(app, e);
    n++;
  }
  return n;
}

/** The forge is stopping: end them all. */
export function stopAllAppTtys(app: App): void {
  for (const e of [...entriesOf(app).values()]) stop(app, e);
}
