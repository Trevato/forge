/**
 * The restore drill: a backup nobody has restored is a hope. `runDrill`
 * takes the newest snapshot, restores it into a fresh directory, opens the
 * database read-only, counts what is in it, opens one sealed value with the
 * restored key, boots the restored directory on a side port and reads
 * `/api/v1/health` and `/`, and removes the directory whatever happened.
 *
 * Plain data out: when it ran, which snapshot, how long, what it counted,
 * and a verdict. A red verdict names the step that failed; a step that
 * hangs past the budget is red too, naming the step it hung in and the
 * budget it had. The budget grows with the snapshot (`drillBudgetMs`),
 * and the store's own deadlines and retries are held inside what is left
 * of it (`Store.bounded`).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { bootRestored } from "./boot.ts";
import { forgetKey, open } from "../kernel/secret.ts";
import { countRows, mismatched, type DrillCounts } from "./counts.ts";
import { restoreSnapshot, type Progress } from "./restore.ts";
import { isOffBox } from "./off_box.ts";
import { listSnapshots } from "./snapshot.ts";
import type { Store } from "./store.ts";

/** The floor of every drill's budget, and the whole budget for finding the newest snapshot. */
export const DRILL_TIMEOUT_MS = 10 * 60_000;
/**
 * What each MB (10^6 bytes) of snapshot adds to the budget: 1 s, a link of
 * 8 Mbit/s for download, decompress and clone together. The 2026-10-14
 * snapshot (a 334 MB database) ran out of a flat 10 min fetching one object
 * at a time (#2667); the 60 s per GiB before this gave that snapshot 19 s
 * more. 8 Mbit/s is about a nineteenth of the forge's shaped 150 Mbit/s
 * downlink, so a drill that keeps to its line has the rest to spare.
 */
export const DRILL_MS_PER_MB = 1_000;
/** No snapshot is given longer than this. */
export const DRILL_MAX_MS = 45 * 60_000;
const MB = 1_000_000;

/**
 * How long a drill of a snapshot of `bytes` may take, in whole ms:
 * 10 min + 1 s per MB (10^6 bytes), capped at 45 min. So 0 B is 10 min,
 * 400 MB is 16 min 40 s, and anything from 2.1 GB up is 45 min. A size
 * that is not a finite count of bytes counts as 0.
 */
export function drillBudgetMs(bytes: number): number {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  return Math.min(DRILL_MAX_MS, Math.round(DRILL_TIMEOUT_MS + (b / MB) * DRILL_MS_PER_MB));
}

/** A snapshot's size from its manifest, or the sum of its files when the total is missing. */
function snapshotBytes(m: { readonly bytes?: unknown; readonly files: readonly { readonly bytes?: unknown }[] }): number {
  if (typeof m.bytes === "number" && Number.isFinite(m.bytes) && m.bytes >= 0) return m.bytes;
  return m.files.reduce((sum, f) => sum + (typeof f.bytes === "number" && Number.isFinite(f.bytes) && f.bytes > 0 ? f.bytes : 0), 0);
}

/** A budget for people: "14 min", "1.5 s", never a raw float of ms. */
export function formatBudget(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 6_000) / 10} min`;
  if (ms >= 1_000) return `${Math.round(ms / 100) / 10} s`;
  return `${Math.round(ms)} ms`;
}

/** A budget in minutes whatever its size, one decimal: "16.7 min", "0.1 min"; for the card. */
export function formatMinutes(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0 min";
  return `${Math.max(0.1, Math.round(ms / 6_000) / 10)} min`;
}

/** A size for people, binary units with one decimal: "4.1 GiB". */
export function formatBytes(bytes: number): string {
  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 10) / 10} ${units[i]}`;
}

/** A span for people: "6 min 12 s", "58 s", "340 ms". */
export function formatSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0 ms";
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 === 0 ? `${m} min` : `${m} min ${s % 60} s`;
}

/** What people call each phase; the manifest read counts as download. */
const PART_WORD: Record<PhaseTime["phase"], string> = {
  manifest: "download",
  files: "download",
  unpack: "decompress",
  bundles: "clone",
  key: "key",
  open: "open",
  boot: "start and migrate",
};

/** The drill's time by part, longest first: download, decompress, clone, open, migrate. Parts that share a word are added. */
export function timeByPart(phases: readonly PhaseTime[]): { part: string; ms: number }[] {
  const sums = new Map<string, number>();
  for (const p of phases) sums.set(PART_WORD[p.phase], (sums.get(PART_WORD[p.phase]) ?? 0) + p.ms);
  return [...sums].map(([part, ms]) => ({ part, ms })).sort((a, b) => b.ms - a.ms);
}

/** "download about 8 min, decompress 40 s, open 2 s; download was the slowest"; empty when nothing was timed. */
export function describeTimes(phases: readonly PhaseTime[]): string {
  const parts = timeByPart(phases).filter((p) => p.part !== "key");
  if (parts.length === 0) return "";
  const words = parts.map((p) => `${p.part} ${p.ms >= 60_000 ? "about " : ""}${formatSpan(p.ms)}`);
  return `${words.join(", ")}; ${parts[0]!.part} was the slowest`;
}

/** One restore phase and the milliseconds it took. */
export interface PhaseTime {
  /** A restore phase, then `open` (the database read) and `boot` (the restored forge starting and migrating). */
  readonly phase: Progress["phase"] | "open" | "boot";
  readonly ms: number;
}

export type DrillStep = "fetch" | "restore" | "open" | "count" | "unseal" | "health";

export interface DrillDeps {
  readonly store: Store;
  /** The forge's data directory; the drill's scratch lives under it. */
  readonly dataDir: string;
  readonly passphrase?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  /** Test seam: the restore itself. */
  readonly restore?: typeof restoreSnapshot | undefined;
  /** Test seam: boot a data directory on a side port and say whether it is healthy. */
  readonly boot?: typeof bootRestored | undefined;
}

export type { DrillCounts };

export interface DrillResult {
  readonly at: string;
  readonly snapshotId: string | null;
  readonly ms: number;
  readonly counts: DrillCounts;
  /** The side-booted forge's word; "unreached" when an earlier step failed. */
  readonly health: "ok" | "failed" | "unreached";
  readonly verdict: "green" | "red";
  readonly failedStep: DrillStep | null;
  /** How long each restore phase took, in the order they began; empty when none was reported. */
  readonly phases: readonly PhaseTime[];
  /** The time the drill was given, in ms. */
  readonly budgetMs: number;
  /** Why it is red, for the person reading; never a value. */
  readonly reason: string | null;
  /** The store it restored from (`Store.where`, never a key); absent on drills kept before #11805. */
  readonly from?: string | undefined;
  /** Whether that store is off the forge's machine (`isOffBox`). */
  readonly offSite?: boolean | undefined;
}

/** The restored forge's front door: `/` answers below 400 (a redirect to sign in is an answer), or this throws. */
export async function answersRoot(base: string): Promise<void> {
  const res = await fetch(`${base}/`, { redirect: "manual", signal: AbortSignal.timeout(5_000) });
  await res.body?.cancel();
  if (res.status >= 400) throw new Error(`the restored forge answered / with ${res.status}`);
}

class StepTimeout extends Error {}

/** Where a restore got to, for people: "bundles (37 of 212 cloned, 1.8 GiB fetched)". */
export function describeProgress(p: Progress): string {
  const unit = p.phase === "bundles" ? ["cloned", "fetched"] : ["done", "so far"];
  return `${p.phase} (${p.done} of ${p.total} ${unit[0]}, ${formatBytes(p.bytes)} ${unit[1]})`;
}

/** Race `work` against `ms`; a loss says `budget`, the whole drill's, not what was left of it. */
function within<T>(work: Promise<T>, ms: number, budget: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepTimeout(`no answer within its ${budget()}`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export async function runDrill(deps: DrillDeps): Promise<DrillResult> {
  const clock = deps.now ?? (() => new Date());
  const started = performance.now();
  const at = clock().toISOString();
  // Until the newest snapshot is known its size is not; the floor holds.
  let budgetMs = deps.timeoutMs ?? DRILL_TIMEOUT_MS;
  let sized: number | undefined;
  const budget = (): string =>
    `${formatBudget(budgetMs)} budget${sized === undefined ? "" : ` for a ${formatBytes(sized)} snapshot`}`;
  const restore = deps.restore ?? restoreSnapshot;
  const counts: { -readonly [K in keyof DrillCounts]: number } = { repositories: 0, issues: 0, users: 0, pulls: 0, apps: 0 };
  let snapshotId: string | null = null;
  let step: DrillStep = "fetch";
  let scratch: string | undefined;
  let reason: string | null = null;
  let progress: Progress | undefined;
  // When each restore phase was first reported, and when the restore ended.
  const began: { phase: Progress["phase"]; at: number }[] = [];
  let restoreEnd: number | undefined;
  let bootStart: number | undefined;
  let health: DrillResult["health"] = "unreached";
  try {
    // One clock for the whole drill, so a hang in any step ends it red.
    const left = (): number => Math.max(1, started + budgetMs - performance.now());
    // Every get, list and retry inside the store keeps to what is left too,
    // so a stalled store gives up within the budget instead of after it.
    const store = deps.store.bounded?.(() => started + budgetMs - performance.now()) ?? deps.store;
    const newest = (await within(listSnapshots(store), left(), budget))[0];
    if (newest === undefined) throw new Error("the store holds no snapshot");
    snapshotId = newest.name;
    sized = snapshotBytes(newest);
    if (deps.timeoutMs === undefined) budgetMs = drillBudgetMs(sized);

    step = "restore";
    const parent = join(deps.dataDir, "drill");
    mkdirSync(parent, { recursive: true });
    scratch = mkdtempSync(join(parent, "restore-"));
    const target = join(scratch, "data");
    await within(
      restore(store, newest.name, target, {
        passphrase: deps.passphrase,
        onProgress: (p) => {
          progress = p;
          if (began[began.length - 1]?.phase !== p.phase) began.push({ phase: p.phase, at: performance.now() });
        },
      }),
      left(),
      budget,
    );
    restoreEnd = performance.now();

    step = "open";
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(target, "forge.db"), { readonly: true });
    try {
      // The constructor is lazy; reading the header is what proves a database.
      db.query("PRAGMA schema_version").get();
      step = "count";
      Object.assign(counts, countRows(db));
      // A snapshot that kept its counts must restore to the same ones.
      const kept = newest.counts;
      const off = kept === undefined ? [] : mismatched(kept, counts);
      if (kept !== undefined && off.length > 0)
        throw new Error(
          `counts differ from the snapshot's: ${off
            .map((k) => `${k} ${kept[k as keyof DrillCounts]} became ${counts[k as keyof DrillCounts]}`)
            .join(", ")}`,
        );

      step = "unseal";
      const secret = db
        .query<{ name: string; scope: string; value_enc: string }, []>(
          "SELECT name, scope, value_enc FROM secret ORDER BY scope, name LIMIT 1",
        )
        .get();
      const env = secret
        ? undefined
        : db
            .query<{ app_id: string; name: string; value_enc: string }, []>(
              "SELECT app_id, name, value_enc FROM app_env ORDER BY app_id, name LIMIT 1",
            )
            .get();
      // A forge with nothing sealed has nothing to open; that is not red.
      const sealed = secret
        ? { value: secret.value_enc, aad: `secret:${secret.scope}:${secret.name}` }
        : env
          ? { value: env.value_enc, aad: `${env.app_id}:${env.name}` }
          : undefined;
      if (sealed !== undefined) {
        const opened = open(target, sealed.value, sealed.aad);
        if (!opened.ok)
          throw new Error(
            "a sealed value does not open with the restored key",
          );
      }
    } finally {
      db.close();
    }

    step = "health";
    bootStart = performance.now();
    const booted = await within(
      (deps.boot ?? bootRestored)(target, left(), undefined, answersRoot),
      left(),
      budget,
    );
    health = booted.ok ? "ok" : "failed";
    if (!booted.ok) throw new Error(booted.reason);
  } catch (error) {
    reason =
      error instanceof StepTimeout && step === "restore" && progress !== undefined
        ? `restore timed out in ${describeProgress(progress)} after its ${formatBudget(budgetMs)} budget`
        : error instanceof StepTimeout
        ? `${step} timed out: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return finish(step);
  } finally {
    if (scratch !== undefined) {
      forgetKey(join(scratch, "data"));
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return finish(null);

  function finish(failedStep: DrillStep | null): DrillResult {
    const end = restoreEnd ?? performance.now();
    const phases: PhaseTime[] = began.map((b, i) => ({
      phase: b.phase,
      ms: Math.max(0, Math.round((began[i + 1]?.at ?? end) - b.at)),
    }));
    // The database read, then the restored forge's start and migration.
    if (restoreEnd !== undefined) {
      const now = performance.now();
      phases.push({ phase: "open", ms: Math.round((bootStart ?? now) - restoreEnd) });
      if (bootStart !== undefined) phases.push({ phase: "boot", ms: Math.round(now - bootStart) });
    }
    return {
      at,
      snapshotId,
      ms: Math.round(performance.now() - started),
      counts,
      health,
      verdict: failedStep === null ? "green" : "red",
      failedStep,
      phases,
      budgetMs,
      reason,
      from: deps.store.where,
      offSite: isOffBox(deps.store),
    };
  }
}
