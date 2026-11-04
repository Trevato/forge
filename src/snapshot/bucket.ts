/**
 * What is actually in the bucket (#8742). Every other backup signal here is
 * a job's own report of itself; when the job dies, so does its report, and
 * the owner was told nothing for 41 days. This reads the store itself —
 * newest snapshot, its size, how many — on a timer that belongs to the
 * forge's own process, and judges it: older than 26 h is red, a lane that
 * cannot be read is red, a restore drill that failed or brought back no data
 * is red, and a read that has not happened for `CHECK_STALE_MS` is red too
 * (the dead man's switch: a check that stops is itself the alarm).
 *
 * The reads are kept in memory per data directory; `backupVerdict` is
 * synchronous, so home, vitals and the MCP's `backups` say the same words
 * without touching the network. Plain data in, plain data out.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DrillResult } from "./drill.ts";
import { isOffBox } from "./off_box.ts";
import { listSnapshots } from "./snapshot.ts";
import { scrubReason } from "./destination.ts";
import type { S3Target, Store } from "./store.ts";

/** A newest snapshot older than this is red: the nightly is 24 h apart, plus a slow one's slack. */
export const LATE_MS = 26 * 3_600_000;
/** How often the bucket is read. */
export const READ_EVERY_MS = 5 * 60_000;
/** No read for this long, however it went, is red. */
export const CHECK_STALE_MS = 20 * 60_000;

export interface LaneRead {
  /** `primary`, `mirror`; a platform lane would add its own name. */
  readonly lane: string;
  readonly where: string;
  readonly offBox: boolean;
  readonly newestAt: string | null;
  readonly newestName: string | null;
  readonly newestBytes: number | null;
  readonly count: number;
  /** Set when the store could not be read: the reason, never a credential. */
  readonly error?: string;
  /** When this read ended. */
  readonly readAt: string;
  /** What the lane backs up, one sentence, from the configuration (#9067). */
  readonly backsUp?: string;
  /** Who reads the lane once the platform is gone, or `retired`. */
  readonly afterSpinDown?: string;
}

/** `retired` in any case: the lane is listed, never read, never red. */
export const isRetired = (afterSpinDown: string | undefined): boolean => afterSpinDown?.trim().toLowerCase() === "retired";

/** The forge's own lanes say their line here; the platform's say it in `FORGE_BACKUP_LANES`. */
const OWN_LINES: Record<string, { backsUp: string; afterSpinDown: string }> = {
  primary: { backsUp: "the forge's snapshot, platform bucket", afterSpinDown: "the app's bucket; read by the in-process check" },
  mirror: { backsUp: "the same snapshot, B2", afterSpinDown: "B2; read by the in-process check and scripts/backup-probe.ts" },
};

/** Shown on a lane that has no line: information, never red. */
export const NO_LINE = "No line yet: say what it backs up and who reads it after spin-down";

/** The two values beside the newest object: each as given, the missing one named; `NO_LINE` when neither is. */
export function laneLine(backsUp: string | null, afterSpinDown: string | null): string {
  if (backsUp === null && afterSpinDown === null) return NO_LINE;
  return `backs up ${backsUp === null ? "(not said)" : printable(backsUp)}; after spin-down: ${afterSpinDown === null ? "(not said)" : printable(afterSpinDown)}`;
}

export interface LaneVerdict extends Omit<LaneRead, "backsUp" | "afterSpinDown"> {
  readonly state: "green" | "red" | "retired";
  readonly says: string;
  /** Both values, or null where the lane has none. */
  readonly backsUp: string | null;
  readonly afterSpinDown: string | null;
  /** What to show beside the newest object: the two values (a missing one named), or `NO_LINE`. */
  readonly line: string;
}

export interface BackupVerdict {
  /** `unknown` is nothing read yet, or nothing yet proving a restore: never calm, never an alarm. */
  readonly state: "green" | "red" | "unknown";
  /** A few words for a tile's note: the first thing wrong, or what is known. */
  readonly note: string;
  /** The one line home shows. */
  readonly line: string;
  /** Every reason it is red, one sentence each; empty when green or unknown. */
  readonly reasons: readonly string[];
  /** Why it is unknown, one sentence each; empty otherwise. */
  readonly unknowns: readonly string[];
  readonly lanes: readonly LaneVerdict[];
  readonly drill: { readonly at: string; readonly ok: boolean; readonly says: string } | null;
  /** The newest snapshot across the lanes. */
  readonly newestAt: string | null;
  /** When the bucket was last read; null when it has not been. */
  readonly checkedAt: string | null;
  /** Runs of the check on record (`backup-checks.jsonl`). */
  readonly runs: number;
  /** When the check last ran and how many runs are on record, as a person reads it; the proof the check is alive. */
  readonly checkLine: string;
}

/** Where each run of the check is written down, under the data directory: one JSON line per run. */
export const CHECK_LOG = "backup-checks.jsonl";
/** The log keeps this many runs; it is cut back to them once it holds twice as many. */
export const CHECK_LOG_KEEP = 200;

/** Runs in each log, counted in memory so a run never reads the file to know its size. */
const runCounts = new Map<string, number>();

function countRuns(dataDir: string): number {
  try {
    return readFileSync(join(dataDir, CHECK_LOG), "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Writes one run down; a disk that refuses must not stop the check, so it never throws. */
export function recordRun(dataDir: string, at: string, lanes: readonly LaneRead[]): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, CHECK_LOG);
    const had = runCounts.get(dataDir) ?? countRuns(dataDir);
    appendFileSync(file, `${JSON.stringify({ at, lanes: lanes.map((l) => ({ lane: l.lane, ok: l.error === undefined, newestAt: l.newestAt })) })}\n`);
    let n = had + 1;
    if (n > CHECK_LOG_KEEP * 2) {
      writeFileSync(file, `${readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-CHECK_LOG_KEEP).join("\n")}\n`);
      n = CHECK_LOG_KEEP;
    }
    runCounts.set(dataDir, n);
  } catch {
    /* the verdict does not depend on the log */
  }
}

const reads = new Map<string, { lanes: LaneRead[]; checkedAt: string; since: string }>();
const watching = new Map<string, string>();

/** Whether a bucket watch has been started for this data directory. */
export const isWatched = (dataDir: string): boolean => watching.has(dataDir);

export function ageWords(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min`;
  if (min < 2880) return `${Math.floor(min / 60)} h`;
  return `${Math.floor(min / 1440)} d`;
}

export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1_073_741_824) return `${(bytes / 1_048_576).toFixed(1)} MiB`;
  return `${(bytes / 1_073_741_824).toFixed(2)} GiB`;
}

/**
 * Text a store wrote (an object key, its error), safe to print: every C0/C1
 * control byte and bidi override becomes `?`, so an ESC in a key never
 * reaches a terminal or an MCP client's screen (#8811).
 */
export const printable = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "?");

/** An error as one short sentence with no key and no presigned query in it. */
export function scrubError(targets: readonly (S3Target | undefined)[], error: unknown): string {
  let reason = String(error instanceof Error ? error.message : error);
  for (const t of targets) reason = scrubReason(t, reason);
  reason = reason
    .replace(/(https?:\/\/)[^\s/@]*@/g, "$1")
    .replace(/\?[^\s"']*(X-Amz-|Signature=|AWSAccessKeyId=)[^\s"']*/gi, "?…");
  return reason.slice(0, 200);
}

/** Read one store: its newest snapshot by manifest. Never throws; a failure is the read. */
export async function readLane(
  lane: string,
  store: Store,
  now = Date.now(),
  /** The credentials this store was opened with, struck out of any error; asked only when a read fails, since opening sealed secrets is audited. */
  targets: () => readonly (S3Target | undefined)[] = () => [],
): Promise<LaneRead> {
  const base = { lane, where: store.where, offBox: isOffBox(store), readAt: new Date(now).toISOString() };
  try {
    const all = await listSnapshots(store);
    const newest = all[0];
    return {
      ...base,
      newestAt: newest?.finishedAt ?? null,
      newestName: newest?.name ?? null,
      newestBytes: newest?.bytes ?? null,
      count: all.length,
    };
  } catch (error) {
    return { ...base, newestAt: null, newestName: null, newestBytes: null, count: 0, error: scrubError(targets(), error) };
  }
}

/** Keep what a pass read. */
export function keepReads(dataDir: string, lanes: LaneRead[], now = Date.now()): void {
  const prev = reads.get(dataDir);
  reads.set(dataDir, { lanes, checkedAt: new Date(now).toISOString(), since: prev?.since ?? new Date(now).toISOString() });
}

export function forgetReads(dataDir: string): void {
  reads.delete(dataDir);
}

/** Is the drill's word good: it passed, and real data came back. */
export function drillCounts(d: Pick<DrillResult, "verdict" | "counts" | "health">): boolean {
  const c = d.counts;
  const rows = c.repositories + c.issues + c.users + c.pulls + c.apps;
  return d.verdict === "green" && d.health === "ok" && rows > 0;
}

/**
 * The verdict, from what was read and the newest drill. `booted` is when
 * this process began watching, so a check that has never run is not red
 * until it has had `CHECK_STALE_MS` to.
 */
export function judge(
  state: { lanes: readonly LaneRead[]; checkedAt: string } | undefined,
  drill: DrillResult | undefined,
  now: number,
  booted: number = now,
): Omit<BackupVerdict, "runs" | "checkLine"> {
  const reasons: string[] = [];
  /** A few words for each reason, for a tile's note. */
  const causes: string[] = [];
  const unknowns: string[] = [];
  const lanes: LaneVerdict[] = [];
  let checkedAt: string | null = state?.checkedAt ?? null;
  const sinceCheck = checkedAt === null ? now - booted : now - Date.parse(checkedAt);
  if (sinceCheck > CHECK_STALE_MS) {
    causes.push("check stopped");
    reasons.push(
      checkedAt === null
        ? "The backup check has never run, so nothing says a backup exists."
        : `The backup check has not run for ${ageWords(sinceCheck)} (last ran ${checkedAt}); it is the alarm, and it is down.`,
    );
  } else if (checkedAt === null) unknowns.push("The bucket has not been read yet, so nothing is known about the backups.");
  for (const r of state?.lanes ?? []) {
    let says: string;
    let red = true;
    // Every word a store or the configuration supplied is made printable before it joins the line.
    const lane = printable(r.lane);
    const where = printable(r.where);
    const own = OWN_LINES[r.lane];
    const backsUp = r.backsUp ?? own?.backsUp ?? null;
    const afterSpinDown = r.afterSpinDown ?? own?.afterSpinDown ?? null;
    const line = laneLine(backsUp, afterSpinDown);
    if (isRetired(afterSpinDown ?? undefined)) {
      lanes.push({ ...r, backsUp, afterSpinDown, state: "retired", says: `${lane} retired${backsUp === null ? "" : `: ${printable(backsUp)}`}`, line });
      continue;
    }
    if (r.error !== undefined) says = `${lane} (${where}) cannot be read: ${printable(r.error)}`;
    else if (r.newestAt === null) says = `${lane} (${where}) holds no snapshot`;
    else {
      const age = now - Date.parse(r.newestAt);
      // The newest object by name, so a person can find it in the store (#8811).
      const name = r.newestName === null ? "" : ` ${printable(r.newestName)}`;
      if (!(age <= LATE_MS)) says = `${lane} (${where}) newest snapshot${name} is ${ageWords(age)} old`;
      else {
        red = false;
        says = `${lane} newest${name} ${ageWords(age)} old, ${sizeWords(r.newestBytes ?? 0)}`;
      }
    }
    if (red) {
      causes.push(r.error !== undefined ? "unreadable" : r.newestAt === null ? "empty" : "late");
      reasons.push(`${says[0]!.toUpperCase()}${says.slice(1)}.`);
    }
    lanes.push({ ...r, backsUp, afterSpinDown, state: red ? "red" : "green", says, line });
  }
  if (state !== undefined && !lanes.some((l) => l.state !== "retired")) {
    causes.push("no destination");
    reasons.push("No place is given for snapshots; none is being taken.");
  }
  let drillSays: BackupVerdict["drill"] = null;
  if (drill !== undefined) {
    const ok = drillCounts(drill);
    const says = ok
      ? `restore drill ${drill.at.slice(0, 10)} passed`
      : drill.verdict === "green"
        ? `restore drill ${drill.at.slice(0, 10)} brought back no data`
        : `restore drill ${drill.at.slice(0, 10)} failed${drill.failedStep ? ` at ${drill.failedStep}` : ""}`;
    drillSays = { at: drill.at, ok, says };
    if (!ok) {
      causes.push(drill.verdict === "green" ? "drill restored nothing" : "drill failed");
      reasons.push(`The last ${says}.`);
    }
  } else if (checkedAt !== null) unknowns.push("No restore drill has run, so nothing shows a snapshot restores.");
  const newest = lanes.map((l) => l.newestAt).filter((t): t is string => t !== null).sort().at(-1) ?? null;
  const primary = lanes[0];
  const head =
    primary?.newestAt != null && primary.error === undefined
      ? `Backup ${ageWords(now - Date.parse(primary.newestAt))} old, ${sizeWords(primary.newestBytes ?? 0)}`
      : "No backup in the bucket";
  const red = reasons.length > 0;
  const unknown = !red && unknowns.length > 0;
  const line = `${head}; ${drillSays?.says ?? "no restore drill yet"}`;
  if (state === undefined) checkedAt = null;
  const sub = lanes[0]?.newestBytes != null ? sizeWords(lanes[0].newestBytes) : "";
  const note = red
    ? causes[0]!
    : unknown
      ? checkedAt === null
        ? "not checked yet"
        : "no restore drill yet"
      : `${sub} · drill passed`;
  return {
    state: red ? "red" : unknown ? "unknown" : "green",
    note,
    line: checkedAt === null && !red ? "Backups not checked yet" : line,
    reasons,
    unknowns,
    lanes,
    drill: drillSays,
    newestAt: newest,
    checkedAt,
  };
}

/** The verdict now, from what the watch last read. */
export function backupVerdict(dataDir: string, drill: DrillResult | undefined, now = Date.now()): BackupVerdict {
  const booted = Date.parse(watching.get(dataDir) ?? "") || now;
  const v = judge(reads.get(dataDir), drill, now, booted);
  const runs = runCounts.get(dataDir) ?? 0;
  const checkLine =
    v.checkedAt === null
      ? "The backup check has not run yet."
      : `The backup check last ran ${v.checkedAt} (${ageWords(now - Date.parse(v.checkedAt))} ago); ${runs} runs on record.`;
  return { ...v, runs, checkLine };
}

/**
 * Read the lanes now and then every `everyMs`, in this process, so the
 * check cannot die with a CronJob. Returns a stop.
 */
export function watchBucket(
  dataDir: string,
  lanes: () => readonly { lane: string; store: Store | undefined }[],
  everyMs: number = READ_EVERY_MS,
  firstMs = 5_000,
  /** The credentials in use, struck out of any error a read keeps. */
  targets: () => readonly (S3Target | undefined)[] = () => [],
  /** The platform's own lanes (`lanes.ts`), read after the forge's and judged beside them. */
  declared: (now: number) => Promise<readonly LaneRead[]> = async () => [],
): { stop: () => void; pass: () => Promise<void> } {
  watching.set(dataDir, new Date().toISOString());
  runCounts.set(dataDir, countRuns(dataDir));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pass = async (): Promise<void> => {
    const stores = lanes().filter((l): l is { lane: string; store: Store } => l.store !== undefined);
    const now = Date.now();
    const [own, more] = await Promise.all([
      Promise.all(stores.map((l) => readLane(l.lane, l.store, now, targets))),
      declared(now).catch(() => []),
    ]);
    const all = [...own, ...more];
    keepReads(dataDir, all);
    recordRun(dataDir, new Date().toISOString(), all);
  };
  const next = (ms: number): void => {
    if (stopped) return;
    timer = setTimeout(() => void pass().catch(() => {}).finally(() => next(everyMs)), ms);
  };
  next(Math.min(firstMs, everyMs));
  return {
    pass,
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      watching.delete(dataDir);
      forgetReads(dataDir);
    },
  };
}
