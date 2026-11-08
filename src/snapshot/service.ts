/**
 * Snapshots on a clock: one a night, pruned to the last fourteen, and one
 * whenever an admin asks. The store is whatever the forge was given — the
 * platform's bucket, or a directory — and a forge given nothing takes no
 * snapshots and says so on its settings page, rather than pretending.
 *
 * Runs are serialized: a nightly that meets an on-demand one waits its
 * turn, and a forge stopping waits for the one in flight. A run that fails
 * is kept (`outcome.ts`) and shows on the board at once, and the next try
 * is within the hour, not the next night.
 */

import type { App } from "../app.ts";
import { createLog } from "../kernel/log.ts";
import { firstSeen, reportVerdict, seedFirstSeen } from "./verdict.ts";
import {
  JOURNAL,
  KEEP,
  listSnapshots,
  pruneSnapshots,
  RESUME_WINDOW_MS,
  SNAPSHOT_PREFIX,
  snapshotStart,
  takeSnapshot,
  type Manifest,
  type Progress,
} from "./snapshot.ts";
import { describeTimes, runDrill, type DrillDeps, type DrillResult } from "./drill.ts";
import { BOOT_RED_FLOOR_MS, drillDue, RED_RETRY_MS, snapshotDue } from "./due.ts";
import { sealedTarget } from "./destination.ts";
import { watchBucket } from "./bucket.ts";
import { readDeclaredLanes } from "./lanes.ts";
import { lastDrill, recordDrill } from "./drills.ts";
import { lastMirror, mirrorPass, mirrorTarget, MIRROR_EVERY_MS, recordMirror, type MirrorState } from "./mirror.ts";
import { isOffBox } from "./off_box.ts";
import { noteOffBox, recordSnapshotOutcome } from "./outcome.ts";
import { s3FromEnv, type Store } from "./store.ts";

const log = createLog("snapshots");

/** When the nightly snapshot is taken, in UTC: before the probe round. */
const NIGHTLY_HOUR_UTC = 8;
/** After a failed snapshot, the next try is this soon (or the nightly, if sooner). */
export const RETRY_MS = 3_600_000;
/** A moving snapshot tells the page how far it is no oftener than this. */
const PROGRESS_EVENT_MS = 2_000;

/**
 * A forge given nowhere to put a snapshot. Not a failure: the Backups page
 * says so calmly, so it is never kept as an outcome, never a card, and
 * never retried sooner than the nightly.
 */
class Nowhere extends Error {
  constructor() {
    super("this forge has nowhere to put a snapshot");
  }
}

export interface SnapshotsHandle {
  /** The store in effect now; undefined when the forge has been given none. */
  readonly store: Store | undefined;
  /** Whether snapshots carry the key, wrapped under a passphrase. */
  readonly wraps: boolean;
  /** Take one now; waits for any in flight. */
  readonly now: () => Promise<Manifest>;
  /** How far the snapshot being taken is; undefined when none is. */
  readonly progress: () => Progress | undefined;
  /** How long the snapshot being taken has run, ms; undefined when none is. The release keeper waits on it (#9653). */
  readonly takingMs: () => number | undefined;
  /** The newest first, from the store. */
  readonly list: () => Promise<Manifest[]>;
  /** The last one taken by this process, and what it said. */
  readonly last: () => { manifest?: Manifest; error?: string; at?: string };
  /** Drill the newest snapshot now and keep the result; waits for any snapshot in flight. */
  readonly drill: () => Promise<DrillResult>;
  /** Drill if this week's slot has no drill yet, or the last one has stood red long enough; says whether it did. */
  readonly drillIfDue: () => Promise<boolean>;
  /** The off-box mirror's store; undefined when the forge has none. */
  readonly mirror: Store | undefined;
  /** Bring the mirror level now; waits for any snapshot in flight. Undefined when there is no mirror. */
  readonly mirrorNow: () => Promise<MirrorState | undefined>;
  /** Like `mirrorNow`, but after any pass already in flight has ended, so it sees the mirror as it now is. */
  readonly mirrorFresh: () => Promise<MirrorState | undefined>;
  /** What the last mirror pass found. */
  readonly mirrored: () => MirrorState | undefined;
  /** Forget the resolved store; the next use resolves again (a new destination was saved). */
  readonly forget: () => void;
  /** Read the bucket now, as the watch does; resolves when the read is kept. */
  readonly checkBucket: () => Promise<void>;
  /** Take a snapshot if the store lacks the night's; says whether it did. For a boot, and for tests. */
  readonly takeIfDue: () => Promise<boolean>;
  readonly stop: () => Promise<void>;
}

const handles = new WeakMap<App, SnapshotsHandle>();
export const snapshotsOf = (app: App): SnapshotsHandle | undefined =>
  handles.get(app);

/** The weekly restore drill: Sunday, an hour after the nightly snapshot. */
const DRILL_DAY_UTC = 0;
const DRILL_HOUR_UTC = 9;
const CATCH_UP_MS = 5 * 60_000;
/** A snapshot due on boot is taken this long after it, once the forge is serving. */
const SNAPSHOT_CATCH_UP_MS = 2 * 60_000;

export function untilDrill(now = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(DRILL_HOUR_UTC, 0, 0, 0);
  while (next.getTime() <= now || next.getUTCDay() !== DRILL_DAY_UTC)
    next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now;
}

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
    /** The off-box mirror, resolved like the destination. */
    readonly mirror?: Store | (() => Store | undefined) | undefined;
    /** Test seam: how often the mirror is looked at. */
    readonly mirrorEveryMs?: number | undefined;
    readonly nightly?: boolean;
    /** Test seam: how often a moving snapshot tells the outbox its progress. */
    readonly progressEventMs?: number | undefined;
    /** Test seam: how soon a failed snapshot is tried again. */
    readonly retryMs?: number | undefined;
    readonly passphrase?: string | undefined;
    /** Test seam: the drill itself. */
    readonly drill?: ((deps: DrillDeps) => Promise<DrillResult>) | undefined;
    /** Test seams: how soon after boot an owed drill runs, and when a red one is owed again. */
    readonly catchUpMs?: number | undefined;
    readonly redRetryMs?: number | undefined;
    readonly bootRedFloorMs?: number | undefined;
    /** Test seams: how soon after boot a due snapshot is taken, and how often the bucket is read. */
    readonly snapshotCatchUpMs?: number | undefined;
    readonly bucketEveryMs?: number | undefined;
    readonly bucketFirstMs?: number | undefined;
    /** Test seam: the clock `takeIfDue` judges by. */
    readonly now?: (() => number) | undefined;
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
  let resolvedMirror: { store: Store | undefined } | undefined;
  const currentMirror = (): Store | undefined => {
    const m = options.mirror;
    if (typeof m !== "function") return m;
    resolvedMirror ??= { store: m() };
    return resolvedMirror.store;
  };
  let stopped = false;
  let inFlight: Promise<Manifest> | undefined;
  let active = 0;
  let running: Progress | undefined;
  let startedAt: number | undefined;
  let last: { manifest?: Manifest; error?: string; at?: string } = {};

  const take = (resume?: Date): Promise<Manifest> => {
    // Whether this run's store is off the machine, for home's backup age (#3701).
    let offBox: boolean | undefined;
    // After the one before it, however that ended: chained on a failure as it
    // was, every later run failed at once with the old error until a restart.
    const run = (inFlight ?? Promise.resolve()).catch(() => {}).then(async () => {
      // Resolved per run, so a destination saved on the Backups page is the
      // very next snapshot's.
      const store = current();
      if (store === undefined) throw new Nowhere();
      offBox = isOffBox(store);
      running = { objects: 0, bytes: 0, elapsedMs: 0 };
      startedAt = Date.now();
      // Admin-only, no repository, nothing /backups does not already show.
      app.bus.append({ kind: "backup.started" });
      let toldAt = Date.now();
      const manifest = await takeSnapshot(
        {
          db: app.db,
          dataDir: app.config.dataDir,
          reposRoot: app.reposRoot,
          version: options.version,
          passphrase: options.passphrase,
          resume: resume !== undefined,
          onLand: (p) => {
            running = p;
            if (Date.now() - toldAt < (options.progressEventMs ?? PROGRESS_EVENT_MS)) return;
            toldAt = Date.now();
            app.bus.append({ kind: "backup.progress", payload: { objects: p.objects, bytes: p.bytes } });
          },
        },
        store,
        resume,
      ).finally(() => {
        running = undefined;
        startedAt = undefined;
      });
      await pruneSnapshots(store, KEEP);
      return manifest;
    });
    // The mirror hears of every snapshot at once; a failure there is its own
    // line on the board and never the snapshot's.
    run.then(() => mirrorNow()).catch(() => {});
    inFlight = run.then(
      (m) => {
        last = { manifest: m, at: m.finishedAt };
        keep({ landed: m.name, ...(offBox === undefined ? {} : { offBox }) });
        app.bus.append({ kind: "backup.finished", payload: { ok: true } });
        arm(untilNightly());
        return m;
      },
      (error) => {
        last = { error: String(error), at: new Date().toISOString() };
        if (error instanceof Nowhere) {
          arm(untilNightly());
          throw error;
        }
        log.error("snapshot failed", { error: String(error) });
        keep({ error: error instanceof Error ? error.message : String(error) });
        app.bus.append({ kind: "backup.finished", payload: { ok: false } });
        arm(Math.min(options.retryMs ?? RETRY_MS, untilNightly()));
        throw error;
      },
    );
    active++;
    inFlight.then(
      () => void active--,
      () => void active--,
    );
    return inFlight;
  };

  // The newest snapshot a release cut short that is newer than the newest
  // whole one and not stale: its journal says what need not go up again.
  const cutShort = async (store: Store, newestWhole: string | undefined): Promise<Date | undefined> => {
    try {
      const names = (await store.names(SNAPSHOT_PREFIX)).sort().reverse();
      const name = names.find((n) => newestWhole === undefined || n > newestWhole);
      const at = name === undefined ? undefined : snapshotStart(name);
      if (name === undefined || at === undefined) return undefined;
      if ((options.now ?? Date.now)() - at.getTime() > RESUME_WINDOW_MS) return undefined;
      return (await store.get(`${SNAPSHOT_PREFIX}${name}/${JOURNAL}`)) === undefined ? undefined : at;
    } catch {
      return undefined;
    }
  };

  // A restart takes the night's snapshot if the store does not hold it: a
  // release at 08:21 killed the one in flight and nothing took it again (#8742).
  // The manifest is written last, so a snapshot cut short is not one.
  const takeIfDue = async (): Promise<boolean> => {
    if (stopped || active > 0) return false;
    const store = current();
    if (store === undefined) return false;
    let newest: Manifest | undefined;
    try {
      newest = (await listSnapshots(store))[0];
    } catch (error) {
      log.warn("snapshot catch-up: store unreadable, not taking one now", { error: String(error) });
      return false;
    }
    if (stopped || active > 0 || !snapshotDue(newest?.finishedAt, (options.now ?? Date.now)())) return false;
    const cut = await cutShort(store, newest?.name);
    log.info("snapshot due or lost; taking one", { newest: newest?.name ?? "none", resuming: cut?.toISOString() ?? "no" });
    await take(cut).catch(() => {});
    return true;
  };

  // Single-flight: two passes at once would copy the same objects twice.
  let mirroring: Promise<MirrorState | undefined> | undefined;
  const mirrorNow = (): Promise<MirrorState | undefined> => {
    mirroring ??= (async () => {
      await (inFlight ?? Promise.resolve()).catch(() => {});
      const dst = currentMirror();
      const src = current();
      // An outcome kept before stores were recorded learns where it landed.
      if (src !== undefined) {
        try {
          noteOffBox(app.config.dataDir, isOffBox(src));
        } catch (error) {
          log.warn("snapshot outcome not annotated", { error: String(error) });
        }
      }
      if (dst === undefined || src === undefined) {
        try {
          recordMirror(app.config.dataDir, undefined);
        } catch (error) {
          log.warn("mirror: state not cleared", { error: String(error) });
        }
        return undefined;
      }
      const state = await mirrorPass(app.config.dataDir, src, dst);
      if (state.sourceError !== undefined) log.error("mirror: primary unreadable", { error: state.sourceError });
      else if (state.failingSince === undefined) log.info("mirror level", { where: state.where, newest: state.newest ?? "none" });
      else log.error("mirror failed", { where: state.where, reachable: state.reachable, error: state.error ?? "" });
      return state;
    })().finally(() => {
      mirroring = undefined;
    });
    return mirroring;
  };

  const mirrorFresh = async (): Promise<MirrorState | undefined> => {
    while (mirroring !== undefined) await mirroring.catch(() => {});
    return mirrorNow();
  };

  // Single-flight: a restore of every repository is heavy, so a second call
  // while one runs joins it instead of filling the disk with another.
  let drilling: Promise<DrillResult> | undefined;
  const drill = (): Promise<DrillResult> => {
    drilling ??= (async (): Promise<DrillResult> => {
      await (inFlight ?? Promise.resolve()).catch(() => {});
      const store = current();
      if (store === undefined)
        throw new Error("this forge has nowhere to drill from");
      // A drill that could not run is not a drill that passed: it is kept red,
      // so the board and the alarm say so instead of the log alone (#8742).
      const result = await (options.drill ?? runDrill)({
        store,
        dataDir: app.config.dataDir,
        passphrase: options.passphrase,
      }).catch(
        (error): DrillResult => ({
          at: new Date().toISOString(),
          snapshotId: null,
          ms: 0,
          counts: { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 },
          health: "unreached",
          verdict: "red",
          failedStep: "restore",
          phases: [],
          budgetMs: 0,
          reason: `the drill did not run: ${String(error).slice(0, 200)}`,
        }),
      );
      recordDrill(app.db, result);
      // The card and the recovery issue hear of every drill, whoever asked.
      const posted = await reportVerdict(app.config.dataDir, result);
      app.bus.append({ kind: "drill.finished", payload: { verdict: result.verdict, step: result.failedStep } });
      log.info("restore drill", { verdict: result.verdict, step: result.failedStep ?? "none", posted, times: describeTimes(result.phases) });
      return result;
    })().finally(() => {
      drilling = undefined;
      // However it was asked for, a red drill is tried again on its own.
      armRedRetry();
    });
    return drilling;
  };

  const keep = (result: { landed: string } | { error: string }): void => {
    try {
      recordSnapshotOutcome(app.config.dataDir, result);
    } catch (error) {
      log.warn("snapshot outcome not kept; the board will not show it", { error: String(error) });
    }
  };

  // One timer for the next snapshot: the nightly, or sooner after a failure.
  // Every run that ends sets it again, whoever asked for the run.
  let timer: ReturnType<typeof setTimeout> | undefined;
  function arm(ms: number): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (options.nightly === false || stopped) return;
    timer = setTimeout(() => void take().catch(() => {}), ms);
  }
  arm(untilNightly());

  // The board only reads; the time the forge first owed a drill is kept here.
  try {
    seedFirstSeen(app.config.dataDir);
  } catch (error) {
    log.warn("drill: first-seen time not kept; a missing drill will not be flagged", { error: String(error) });
  }

  let catchUp: ReturnType<typeof setTimeout> | undefined;
  let drillTimer: ReturnType<typeof setTimeout> | undefined;
  let redRetry: ReturnType<typeof setTimeout> | undefined;
  const catchUpMs = options.catchUpMs ?? CATCH_UP_MS;
  const redRetryMs = options.redRetryMs ?? RED_RETRY_MS;
  const scheduleDrill = (): void => {
    if (options.nightly === false || stopped) return;
    drillTimer = setTimeout(() => {
      runIfDue().finally(scheduleDrill);
    }, untilDrill());
  };
  // While the newest drill is red, look again when it is owed again.
  const armRedRetry = (): void => {
    if (redRetry !== undefined) clearTimeout(redRetry);
    redRetry = undefined;
    if (options.nightly === false || stopped) return;
    const newest = lastDrill(app.db);
    if (newest?.verdict !== "red") return;
    const wait = Math.max(catchUpMs, Date.parse(newest.at) + redRetryMs - Date.now());
    redRetry = setTimeout(() => void runIfDue().finally(armRedRetry), wait);
  };
  // Owed and not yet kept: run it once. A restart after a green drill finds it
  // kept; one after a red drill runs it again, once it is past the boot floor.
  const runIfDue = async (redAfterMs: number = redRetryMs): Promise<boolean> => {
    if (!drillDue(lastDrill(app.db), firstSeen(app.config.dataDir), Date.now(), redAfterMs)) return false;
    await drill().catch((error) => log.error("restore drill failed to run", { error: String(error) }));
    return true;
  };
  scheduleDrill();
  // A forge that was down at the slot, or whose last drill was red, drills
  // shortly after boot; a red one is looked at again until one passes.
  if (options.nightly !== false) {
    catchUp = setTimeout(
      () => void runIfDue(options.bootRedFloorMs ?? BOOT_RED_FLOOR_MS).finally(armRedRetry),
      catchUpMs,
    );
  }

  // Within the hour: look for snapshots the mirror lacks, soon after boot and then hourly.
  let mirrorTimer: ReturnType<typeof setTimeout> | undefined;
  const everyMs = options.mirrorEveryMs ?? MIRROR_EVERY_MS;
  const scheduleMirror = (first: boolean): void => {
    if (options.nightly === false || stopped) return;
    mirrorTimer = setTimeout(() => {
      mirrorNow()
        .catch(() => {})
        .finally(() => scheduleMirror(false));
    }, first ? Math.min(30_000, everyMs) : everyMs);
  };
  scheduleMirror(true);

  const catchUpSnapshot =
    options.nightly === false ? undefined : setTimeout(() => void takeIfDue(), options.snapshotCatchUpMs ?? SNAPSHOT_CATCH_UP_MS);

  // The bucket is read by this process, on its own clock, whatever any job says.
  const bucket = watchBucket(
    app.config.dataDir,
    () => [
      { lane: "primary", store: current() },
      { lane: "mirror", store: currentMirror() },
    ],
    options.bucketEveryMs,
    options.bucketFirstMs,
    () => {
      const sources = { db: app.db, dataDir: app.config.dataDir, bus: app.bus };
      try {
        return [sealedTarget(sources), s3FromEnv(), mirrorTarget(sources)?.target];
      } catch {
        return [s3FromEnv()];
      }
    },
    (now) => readDeclaredLanes(process.env, now),
  );

  const handle: SnapshotsHandle = {
    get store() {
      return current();
    },
    wraps: !!options.passphrase,
    now: take,
    drill,
    drillIfDue: () => runIfDue(),
    list: async () => {
      const store = current();
      return store === undefined ? [] : listSnapshots(store);
    },
    last: () => last,
    progress: () => running,
    takingMs: () => (startedAt === undefined ? undefined : Date.now() - startedAt),
    get mirror() {
      return currentMirror();
    },
    mirrorNow,
    mirrorFresh,
    checkBucket: bucket.pass,
    takeIfDue,
    mirrored: () => lastMirror(app.config.dataDir),
    forget: () => {
      resolved = undefined;
      resolvedMirror = undefined;
    },
    stop: async () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      if (drillTimer !== undefined) clearTimeout(drillTimer);
      if (catchUp !== undefined) clearTimeout(catchUp);
      if (redRetry !== undefined) clearTimeout(redRetry);
      if (mirrorTimer !== undefined) clearTimeout(mirrorTimer);
      if (catchUpSnapshot !== undefined) clearTimeout(catchUpSnapshot);
      bucket.stop();
      if (mirroring !== undefined) await mirroring.catch(() => {});
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
