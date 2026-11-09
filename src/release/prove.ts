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
 * for the version's whole life (#7622). A first proof gives up after ten
 * minutes without the public URL answering as the version; the first
 * `QUICK_RETRIES` give-ups in a row are asked again after one tick and a
 * retry polls only `RETRY_POLL_MS`, since the swap may only be late (#9942,
 * #10168, #10222). After that the plain doubling takes over, so a version
 * that never answers costs its public URL a few loads an hour. When a newer
 * release answers instead, this process is being replaced: it keeps nothing
 * and does not poll again for `GIVE_UP_MS` (#10138); still running after
 * that, it was not replaced and proves its version again (#10248).
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
/** How long a retry after a give-up waits for the public URL to answer as the version: the long wait was already spent (#10222). */
export const RETRY_POLL_MS = 10_000;
/** How many give-ups in a row are retried after one tick before the doubling takes over. */
export const QUICK_RETRIES = 10;
/** A proof not ended by then is hung: the next tick is scheduled anyway, or the last failure would stand for hours (#10313). */
export const HANG_MS = GIVE_UP_MS + 5 * 60_000;

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
  /** The failure was the give-up: ten minutes already spent polling; only its first retry skips the backoff (#10168). */
  readonly gaveUp?: boolean;
}

/**
 * The wait after a version's `failures`th failed proof in a row: `RETRY_MS`
 * doubled per failure, capped at `MAX_RETRY_MS`. A proof that failed only
 * because an answer was slow (`slow`) is a moment's load, not a broken
 * release, so it waits `min(that, TICK_MS * failures)`: 1, 2, 3, 4 minutes,
 * then the doubling takes over (#9238). A give-up (`gaveUp`) is probably a
 * late swap: its first `QUICK_RETRIES` in a row wait one tick (#10222), the
 * ones after the plain doubling.
 */
export function retryAfter(failures: number, slow = false, gaveUp = false): number {
  if (gaveUp && failures <= QUICK_RETRIES) return TICK_MS;
  const backoff = Math.min(MAX_RETRY_MS, RETRY_MS * 2 ** Math.max(0, Math.min(failures, 20) - 1));
  return slow ? Math.min(backoff, TICK_MS * Math.max(1, failures)) : backoff;
}

/** Is dotted version `a` later than `b`; false when either is not numeric dotted. */
export function isNewer(a: string, b: string): boolean {
  const x = a.split("."), y = b.split(".");
  if (![...x, ...y].every((n) => /^\d+$/.test(n))) return false;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = Number(x[i] ?? 0) - Number(y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Versions this process saw a newer release answer for, and until when it
 * does not poll for them again. A replaced process is gone well within
 * `GIVE_UP_MS`; one still running after it was not replaced (a roll the
 * launcher undid), so it proves its version again rather than leave the last
 * kept failure, and its past retry time, standing for hours (#10248).
 */
const superseded = new Map<string, number>();

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
export function proofNeed(dataDir: string, running?: string): { sentence: string; since: string } | undefined {
  const p = lastProof(dataDir);
  if (p === undefined || p.ok) return undefined;
  // Only the process running a version proves it: a failure kept for another version is not
  // this process's to report, and stood for hours after a roll or a newer boot (#10248).
  if (running !== undefined && running !== UNSTAMPED && p.version !== running) return undefined;
  const next = Date.parse(p.at) + retryAfter(p.failures ?? 1, p.slow === true, p.gaveUp === true);
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
  /** Aborted when the proof is hung: its asks stop and it keeps no verdict (#10313). */
  readonly signal?: AbortSignal;
}

/** Is a proof of `version` due: never tried, or failed `retryAfter` its failures or more ago? */
export function proofDue(last: Proof | undefined, version: string, now: number): boolean {
  if (version === UNSTAMPED) return false;
  if (last?.version !== version) return true;
  if (last.ok) return false;
  const at = Date.parse(last.at);
  return !Number.isFinite(at) || now - at >= retryAfter(last.failures ?? 1, last.slow === true, last.gaveUp === true);
}

/**
 * Proves `version` unless it was proven before, or its last failure's
 * `retryAfter` has not passed. Returns what was kept, or undefined when nothing ran. Throws only when `signal` aborts it.
 */
export async function proveRelease(o: ProveOptions): Promise<Proof | undefined> {
  const now = o.now ?? Date.now;
  const last = lastProof(o.dataDir);
  if (now() < (superseded.get(o.version) ?? -Infinity) || !proofDue(last, o.version, now())) return undefined;
  const sleep = o.sleep ?? Bun.sleep;
  const baseFetch = o.fetch ?? fetch;
  const doFetch = ((url, init) => baseFetch(url, o.signal ? { ...init, signal: init?.signal ? AbortSignal.any([init.signal, o.signal]) : o.signal } : init)) as typeof fetch;
  const failedBefore = last?.version === o.version && !last.ok ? last : undefined;
  const finish = (failure?: string, slow = false, gaveUp = false): Proof => {
    if (o.signal?.aborted) throw new Error("the proof was aborted as hung");
    const at = new Date(now()).toISOString();
    return keep(o.dataDir, {
      version: o.version,
      at,
      ok: failure === undefined,
      ...(failure === undefined
        ? {}
        : { failure, since: failedBefore ? (failedBefore.since ?? failedBefore.at) : at, failures: (failedBefore?.failures ?? (failedBefore ? 1 : 0)) + 1, ...(slow ? { slow } : {}), ...(gaveUp ? { gaveUp } : {}) }),
    });
  };
  try {
    const health = new URL("/healthz", o.url).href;
    const deadline = now() + (o.giveUpMs ?? (failedBefore?.gaveUp === true ? RETRY_POLL_MS : GIVE_UP_MS));
    let seen = "";
    for (;;) {
      if (o.signal?.aborted) throw new Error("the proof was aborted as hung");
      try {
        // Each ask is a fresh URL and says no-cache, so a proxy or edge holding an older /healthz answer cannot stand for the public URL (#10184).
        const res = await doFetch(`${health}?proof=${now()}`, { redirect: "manual", cache: "no-store", headers: { ...ownProbeHeaders(o.dataDir), "cache-control": "no-cache" }, signal: AbortSignal.timeout(5_000) });
        await res.body?.cancel();
        seen = res.headers.get("x-forge-version") ?? "";
        if (seen === o.version) break;
      } catch {
        // not up yet at its public address
      }
      if (now() + POLL_MS > deadline) {
        // A newer release answers: this process is being replaced, and a failure kept now would stand over the newer version's own proof.
        if (isNewer(seen, o.version)) {
          superseded.set(o.version, now() + GIVE_UP_MS);
          return undefined;
        }
        return finish(`the public URL never answered as ${o.version}`, true, true);
      }
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
  hangMs = HANG_MS,
  log?: Pick<Log, "warn">,
): () => void {
  let cancel: (() => void) | undefined;
  let stopped = false;
  // True from a proof's start until it settles: a proof is never started over one still running.
  let running = false;
  const next = (): void => {
    if (!stopped) cancel = schedule(() => void tick(), everyMs);
  };
  const tick = async (): Promise<void> => {
    if (running) {
      log?.warn("release proof still running", { version: o.version });
      return next();
    }
    running = true;
    const abort = new AbortController();
    const work = prove({ ...o, signal: abort.signal }).then(
      (p) => ({ p }),
      (error) => {
        log?.warn("release proof failed", { version: o.version, error: String(error) });
        return { p: undefined };
      },
    );
    void work.finally(() => void (running = false));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hung = new Promise<"hung">((resolve) => {
      timer = setTimeout(() => resolve("hung"), hangMs);
      timer.unref?.();
    });
    const result = await Promise.race([work, hung]);
    clearTimeout(timer);
    if (result === "hung") {
      // Stop its asks; the next tick waits for it to settle rather than run beside it.
      log?.warn("release proof hung", { version: o.version, afterMs: hangMs });
      abort.abort();
    } else if (result.p) done(result.p);
    next();
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
  log: Pick<Log, "info" | "warn">,
  everyMs = TICK_MS,
  schedule: Schedule = unrefTimer,
  prove: (o: ProveOptions) => Promise<Proof | undefined> = proveRelease,
): () => void {
  return startProving(o, (p) => log.info("release proof", { version: p.version, ok: String(p.ok), ...(p.failure ? { failure: p.failure } : {}) }), everyMs, schedule, prove, HANG_MS, log);
}
