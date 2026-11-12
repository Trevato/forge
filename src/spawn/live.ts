/**
 * Time to live (#2932): the moment a spawned child's `/health` first
 * answers, recorded on the outbox as `forge.spawn.live` with the ms since
 * the spawn began, or `forge.spawn.failed` at step `health` when it never
 * does. The boards read both (`boards/sources.ts`). One watcher per child,
 * polling its public address; the probe is injected so a test needs no network.
 * The watcher lives in this process: a restart mid-spawn leaves a `started`
 * with no `live` or `failed`, and the boards show that gap as unfinished.
 */
import type { App } from "../app.ts";

export const POLL_MS = 1000;
/** After this long without an answer, poll every `SLOW_POLL_MS` instead. */
export const SLOW_AFTER_MS = 30_000;
export const SLOW_POLL_MS = 5000;
/** At most this many watchers at once per forge; a spawn past it is made but not timed. */
export const MAX_WATCHERS = 20;
const open = new WeakMap<App, number>();
/** Give up after this long: well past the 3-minute budget, so a slow forge still counts as live, late. */
export const GIVE_UP_MS = 10 * 60_000;

export type Probe = () => Promise<boolean>;

/** A probe of `<url>/healthz`: true on a 200, false on anything else. Never throws. */
export function probeOf(url: string, timeoutMs = 2000): Probe {
  return async () => {
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      await res.body?.cancel();
      return res.status === 200;
    } catch {
      return false;
    }
  };
}

export interface Watch {
  readonly name: string;
  /** When the spawn began, ms since the epoch. */
  readonly startedAt: number;
  readonly probe: Probe;
  readonly drill?: boolean;
  readonly pollMs?: number;
  readonly giveUpMs?: number;
  readonly now?: () => number;
}

/** Start a watcher unless this forge already runs `MAX_WATCHERS`; true when started. */
export function startWatch(app: App, w: Watch): boolean {
  const n = open.get(app) ?? 0;
  if (n >= MAX_WATCHERS) return false;
  open.set(app, n + 1);
  void watchLive(app, w).finally(() => open.set(app, (open.get(app) ?? 1) - 1));
  return true;
}

/**
 * Poll until the child answers or time runs out; appends exactly one event,
 * or none when the forge closes first. Never throws.
 */
export async function watchLive(app: App, w: Watch): Promise<"live" | "failed" | "stopped"> {
  const now = w.now ?? Date.now;
  const poll = w.pollMs ?? POLL_MS;
  const until = w.startedAt + (w.giveUpMs ?? GIVE_UP_MS);
  const drill = w.drill === true ? { drill: 1 } : {};
  const sleep = (ms: number) =>
    new Promise<void>((done) => {
      const t = setTimeout(done, ms);
      app.closing.signal.addEventListener("abort", () => { clearTimeout(t); done(); }, { once: true });
    });
  while (true) {
    if (app.closing.signal.aborted) return "stopped";
    let up = false;
    try {
      up = await w.probe();
    } catch {
      up = false;
    }
    if (app.closing.signal.aborted) return "stopped";
    if (up) {
      const ms = Math.max(0, Math.round(now() - w.startedAt));
      app.bus.append({ kind: "forge.spawn.live", payload: { ms, ...drill } });
      return "live";
    }
    const t = now();
    if (t >= until) break;
    await sleep(t - w.startedAt >= SLOW_AFTER_MS ? Math.max(poll, SLOW_POLL_MS) : poll);
  }
  app.bus.append({ kind: "forge.spawn.failed", payload: { step: "health", ...drill } });
  return "failed";
}
