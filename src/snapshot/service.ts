/**
 * Snapshots on a clock: one a night, pruned to the last fourteen, and one
 * whenever an admin asks. The store is whatever the forge was given — the
 * platform's bucket, or a directory — and a forge given nothing takes no
 * snapshots and says so on its settings page, rather than pretending.
 *
 * Runs are serialized: a nightly that meets an on-demand one waits its
 * turn, and a forge stopping waits for the one in flight.
 */

import type { App } from "../app.ts";
import { createLog } from "../kernel/log.ts";
import {
  KEEP,
  listSnapshots,
  pruneSnapshots,
  takeSnapshot,
  type Manifest,
  type Progress,
} from "./snapshot.ts";
import type { Store } from "./store.ts";

const log = createLog("snapshots");

/** When the nightly snapshot is taken, in UTC: before the probe round. */
const NIGHTLY_HOUR_UTC = 8;

export interface SnapshotsHandle {
  /** The store in effect now; undefined when the forge has been given none. */
  readonly store: Store | undefined;
  /** Whether snapshots carry the key, wrapped under a passphrase. */
  readonly wraps: boolean;
  /** Take one now; waits for any in flight. */
  readonly now: () => Promise<Manifest>;
  /** How far the snapshot being taken is; undefined when none is. */
  readonly progress: () => Progress | undefined;
  /** The newest first, from the store. */
  readonly list: () => Promise<Manifest[]>;
  /** The last one taken by this process, and what it said. */
  readonly last: () => { manifest?: Manifest; error?: string; at?: string };
  /** Forget the resolved store; the next use resolves again (a new destination was saved). */
  readonly forget: () => void;
  readonly stop: () => Promise<void>;
}

const handles = new WeakMap<App, SnapshotsHandle>();
export const snapshotsOf = (app: App): SnapshotsHandle | undefined =>
  handles.get(app);

export function untilNightly(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(NIGHTLY_HOUR_UTC, 0, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

export function startSnapshots(
  app: App,
  destination: Store | (() => Store | undefined),
  options: {
    readonly version: string;
    readonly nightly?: boolean;
    readonly passphrase?: string | undefined;
  } = {
    version: "0",
  },
): SnapshotsHandle {
  // Resolving opens sealed secrets, which is audited: do it once per change,
  // not once per page view.
  let resolved: { store: Store | undefined } | undefined;
  const current = (): Store | undefined => {
    if (typeof destination !== "function") return destination;
    resolved ??= { store: destination() };
    return resolved.store;
  };
  let stopped = false;
  let inFlight: Promise<Manifest> | undefined;
  let running: Progress | undefined;
  let last: { manifest?: Manifest; error?: string; at?: string } = {};

  const take = (): Promise<Manifest> => {
    const run = (inFlight ?? Promise.resolve()).then(async () => {
      // Resolved per run, so a destination saved on the Backups page is the
      // very next snapshot's.
      const store = current();
      if (store === undefined)
        throw new Error("this forge has nowhere to put a snapshot");
      running = { objects: 0, bytes: 0, elapsedMs: 0 };
      const manifest = await takeSnapshot(
        {
          db: app.db,
          dataDir: app.config.dataDir,
          reposRoot: app.reposRoot,
          version: options.version,
          passphrase: options.passphrase,
          onLand: (p) => {
            running = p;
          },
        },
        store,
      ).finally(() => {
        running = undefined;
      });
      await pruneSnapshots(store, KEEP);
      return manifest;
    });
    inFlight = run.then(
      (m) => {
        last = { manifest: m, at: m.finishedAt };
        return m;
      },
      (error) => {
        last = { error: String(error), at: new Date().toISOString() };
        log.error("snapshot failed", { error: String(error) });
        throw error;
      },
    );
    return inFlight;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = (): void => {
    if (options.nightly === false || stopped) return;
    timer = setTimeout(() => {
      take()
        .catch(() => {})
        .finally(schedule);
    }, untilNightly());
  };
  schedule();

  const handle: SnapshotsHandle = {
    get store() {
      return current();
    },
    wraps: !!options.passphrase,
    now: take,
    list: async () => {
      const store = current();
      return store === undefined ? [] : listSnapshots(store);
    },
    last: () => last,
    progress: () => running,
    forget: () => {
      resolved = undefined;
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (inFlight !== undefined) await inFlight.catch(() => {});
      if (handles.get(app) === handle) handles.delete(app);
    },
  };
  handles.set(app, handle);
  log.info("snapshots on", {
    where: current()?.where ?? "nowhere",
    keep: KEEP,
    key: options.passphrase ? "wrapped" : "none",
  });
  return handle;
}
