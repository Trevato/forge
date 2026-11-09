/**
 * Is this release so: once per version, after a boot that changed it, the
 * forge waits for its own public URL to answer `/healthz` as that version,
 * then runs the smoke checks (`release/smoke.ts`) against it. The verdict is
 * one small file under the data directory (`release/proof.json`), so a
 * restart of a proven version never runs it again and vitals reads it
 * without the network. A failure is a `release` card, paged once by the
 * cause pager, until a later version passes or the same version is proven
 * again: `startProving` asks every minute, and a failed version runs again
 * once `retryAfter` has passed since its last try (5 minutes, doubling each
 * failure up to an hour), so one slow answer in the watch no longer stands
 * for the version's whole life (#7622) and a version that stays broken
 * costs its public URL a few loads an hour, not one every 5 minutes. It
 * gives up after ten minutes; a give-up is retried as a slow answer is, since the swap may only be late (#9942).
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { smoke, type Failure, type Heavy } from "./smoke.ts";
import { UNSTAMPED } from "../kernel/version.ts";
import { ownProbeHeaders } from "../kernel/probe.ts";
import type { Log } from "../kernel/log.ts";

/** How long the public URL has to answer as the new version. */
export const GIVE_UP_MS = 10 * 60_000;
const POLL_MS = 2_000;
/** How long after a first failed proof the same version is proven again; each failure after doubles it. */
export const RETRY_MS = 5 * 60_000;
/** The longest wait between two proofs of a version that keeps failing. */
export const MAX_RETRY_MS = 60 * 60_000;
/** How often `startProving` asks whether a proof is due. */
export const TICK_MS = 60_000;

export interface Proof {
  readonly version: string;
  readonly at: string;
  readonly ok: boolean;
  /** The first failing check, or the give-up, when `ok` is false. */
  readonly failure?: string;
  /** When this version first failed, kept across retries that fail again. */
  readonly since?: string;
  /** How many proofs of this version have failed in a row; 1 when unset. */
  readonly failures?: number;
  /** The first failing check was only a slow, empty or hung answer (`Failure.slow`, `.empty`, `.hung`); retried sooner (#9358, #9482). */
  readonly slow?: boolean;
}

/**
 * The wait after a version's `failures`th failed proof in a row: `RETRY_MS`
 * doubled per failure, capped at `MAX_RETRY_MS`. A proof that failed only
 * because an answer was slow (`slow`) is a moment's load, not a broken
 * release, so it waits `min(that, TICK_MS * failures)`: 1, 2, 3, 4 minutes,
 * then the doubling takes over (#9238).
 */
export function retryAfter(failures: number, slow = false): number {
  const backoff = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.max(0, Math.min(failures, 20) - 1));
  return slow ? Math.min(backoff, TICK_MS * Math.max(1, failures)) : backoff;
}

const proofFile = (dataDir: string): string => join(dataDir, "release", "proof.json");

/** The last verdict kept, or undefined when none is or the file is not one. */
export function lastProof(dataDir: string): Proof | undefined {
  try {
    const p = JSON.parse(readFileSync(proofFile(dataDir), "utf8")) as Proof;
    if (typeof p.version !== "string" || typeof p.at !== "string" || typeof p.ok !== "boolean") return undefined;
    return p;
  } catch {
    return undefined;
  }
}

function keep(dataDir: string, proof: Proof): Proof {
  mkdirSync(join(dataDir, "release"), { recursive: true });
  const tmp = `${proofFile(dataDir)}.tmp`;
  writeFileSync(tmp, JSON.stringify(proof));
  renameSync(tmp, proofFile(dataDir));
  return proof;
}

/** The card an unproven release is, saying when it is tried again; undefined while the last verdict is a pass. */
export function proofNeed(dataDir: string): { sentence: string; since: string } | undefined {
  const p = lastProof(dataDir);
  if (p === undefined || p.ok) return undefined;
  const next = Date.parse(p.at) + retryAfter(p.failures ?? 1, p.slow === true);
  // When it is tried again, so a person reading the card knows it is not stuck.
  const again = Number.isFinite(next) ? ` It is proven again at ${new Date(next).toISOString().slice(11, 16)} UTC.` : "";
  return { sentence: `Release ${p.version} is unproven: ${p.failure ?? "a smoke check failed"}.${again}`, since: p.since ?? p.at };
}

/** A failing check as one line: where, as whom, and why. */
export function checkLine(f: Failure): string {
  return `${f.url}${f.agent === "-" ? "" : ` as ${f.agent}`} ${f.why} (status ${f.status})`;
}

export interface ProveOptions {
  readonly dataDir: string;
  readonly version: string;
  /** The forge's public URL. */
  readonly url: string;
  /** Signs `/board` in; without it a redirect to sign-in passes. */
  readonly token?: string | undefined;
  /** An app's URL on this forge: its `/` must never be the forge's page (#6726). */
  readonly appHost?: string | undefined;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly giveUpMs?: number;
  /** The heavy-page load and `/healthz` watch after go-live; a shorter window for a test. */
  readonly heavy?: Heavy;
}

/** Is a proof of `version` due: never tried, or failed `retryAfter` its failures or more ago? */
export function proofDue(last: Proof | undefined, version: string, now: number): boolean {
  if (version === UNSTAMPED) return false;
  if (last?.version !== version) return true;
  if (last.ok) return false;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now - at >= retryAfter(last.failures ?? 1, last.slow === true);
}

/**
 * Proves `version` unless it was proven before, or its last failure's
 * `retryAfter` has not passed. Returns what was kept, or undefined when nothing ran. Never throws.
 */
export async function proveRelease(o: ProveOptions): Promise<Proof | undefined> {
  const now = o.now ?? Date.now;
  const last = lastProof(o.dataDir);
  if (!proofDue(last, o.version, now())) return undefined;
  const sleep = o.sleep ?? Bun.sleep;
  const doFetch = o.fetch ?? fetch;
  const failedBefore = last?.version === o.version && !last.ok ? last : undefined;
  const finish = (failure?: string, slow = false): Proof => {
    const at = new Date(now()).toISOString();
    return keep(o.dataDir, {
      version: o.version,
      at,
      ok: failure === undefined,
      ...(failure === undefined
        ? {}
        : { failure, since: failedBefore ? (failedBefore.since ?? failedBefore.at) : at, failures: (failedBefore?.failures ?? (failedBefore ? 1 : 0)) + 1, ...(slow ? { slow } : {}) }),
    });
  };
  try {
    const health = new URL("/healthz", o.url).href;
    const deadline = now() + (o.giveUpMs ?? GIVE_UP_MS);
    for (;;) {
      try {
        const res = await doFetch(health, { redirect: "manual", headers: ownProbeHeaders(o.dataDir), signal: AbortSignal.timeout(5_000) });
        await res.body?.cancel();
        if (res.headers.get("x-forge-version") === o.version) break;
      } catch {
        // not up yet at its public address
      }
      if (now() + POLL_MS > deadline) return finish(`the public URL never answered as ${o.version}`, true);
      await sleep(POLL_MS);
    }
    const failures = await smoke(o.url, o.token ?? "", {
      fetch: doFetch,
      anonymousBoard: true,
      heavy: { version: o.version, probe: ownProbeHeaders(o.dataDir), ...o.heavy }, ...(o.appHost ? { appHost: o.appHost } : {}),
    });
    return finish(failures[0] === undefined ? undefined : checkLine(failures[0]), failures[0]?.slow === true || failures[0]?.empty === true || failures[0]?.hung === true);
  } catch (error) {
    return finish(`the smoke checks could not run: ${String(error)}`);
  }
}

/** Runs `fn` after `ms`; returns its cancel. */
export type Schedule = (fn: () => void, ms: number) => () => void;

const unrefTimer: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * Proves the running version now, then asks every `everyMs` whether a proof
 * is due (`proofDue`); one proof runs at a time, the next tick scheduled
 * only once it ends. `done` hears each that ran. `schedule` and `prove` are
 * a test's to replace. Returns the stop.
 */
export function startProving(
  o: ProveOptions,
  done: (p: Proof) => void,
  everyMs = TICK_MS,
  schedule: Schedule = unrefTimer,
  prove: (o: ProveOptions) => Promise<Proof | undefined> = proveRelease,
): () => void {
  let cancel: (() => void) | undefined;
  let stopped = false;
  const tick = async (): Promise<void> => {
    const p = await prove(o);
    if (p) done(p);
    if (!stopped) cancel = schedule(() => void tick(), everyMs);
  };
  void tick();
  return () => {
    stopped = true;
    cancel?.();
  };
}

/** What the forge runs at boot (`main.ts`): `startProving`, each verdict one `release proof` line in `log`. */
export function proveRunning(
  o: ProveOptions,
  log: Pick<Log, "info">,
  everyMs = TICK_MS,
  schedule: Schedule = unrefTimer,
  prove: (o: ProveOptions) => Promise<Proof | undefined> = proveRelease,
): () => void {
  return startProving(o, (p) => log.info("release proof", { version: p.version, ok: String(p.ok), ...(p.failure ? { failure: p.failure } : {}) }), everyMs, schedule, prove);
}
