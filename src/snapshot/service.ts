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
} from "./snapshot.ts";
import type { Store } from "./store.ts";

const log = createLog("snapshots");

/** When the nightly snapshot is taken, in UTC: before the probe round. */
const NIGHTLY_HOUR_UTC = 8;

export interface SnapshotsHandle {
  readonly store: Store;
  /** Take one now; waits for any in flight. */
  readonly now: () => Promise<Manifest>;
  /** The newest first, from the store. */
  readonly list: () => Promise<Manifest[]>;
  /** The last one taken by this process, and what it said. */
  readonly last: () => { manifest?: Manifest; error?: string; at?: string };
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
  store: Store,
  options: { readonly version: string; readonly nightly?: boolean } = {
    version: "0",
  },
): SnapshotsHandle {
  let stopped = false;
  let inFlight: Promise<Manifest> | undefined;
  let last: { manifest?: Manifest; error?: string; at?: string } = {};

  const take = (): Promise<Manifest> => {
    const run = (inFlight ?? Promise.resolve()).then(async () => {
      const manifest = await takeSnapshot(
        {
          db: app.db,
          dataDir: app.config.dataDir,
          reposRoot: app.reposRoot,
          version: options.version,
        },
        store,
      );
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
    store,
    now: take,
    list: () => listSnapshots(store),
    last: () => last,
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (inFlight !== undefined) await inFlight.catch(() => {});
      if (handles.get(app) === handle) handles.delete(app);
    },
  };
  handles.set(app, handle);
  log.info("snapshots on", { where: store.where, keep: KEEP });
  return handle;
}
