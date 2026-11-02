/**
 * Proving a release live (#7557), as the steward's `verify-release.sh` did:
 * for ten minutes, the pages people open are fetched one at a time as an
 * admin (/boards, the forge's repository, /explore, /) while `/healthz` is
 * probed once a second. A probe is bad when it is not a 200 or takes over
 * 10 s; three bad probes in a row fail the release.
 *
 * Each probe stands for one second, so the seconds dark are the probes
 * that got no 200 — a slow 200 is slow, not dark. The same tally counts
 * the roll (`roll: true`), where the target is zero with surge.
 *
 * `tally` is plain data in, plain data out. `verifyUnderLoad` drives it
 * with the fetch, clock and sleep it is handed, so a test runs ten minutes
 * of probes in no time.
 */

/** A probe slower than this is bad: 10 s. */
export const SLOW_MS = 10_000;
/** This many bad probes in a row fail a release. */
export const FAIL_AFTER = 3;
/** How long a release is held under page load: 10 minutes. */
export const VERIFY_MS = 10 * 60_000;
/** One `/healthz` probe a second. */
export const PROBE_EVERY_MS = 1000;

export interface Probe {
  /** The HTTP status; 0 when nothing answered. */
  readonly status: number;
  readonly ms: number;
}

export interface Tally {
  readonly probes: number;
  readonly non200: number;
  /** Bad probes in a row now, and the most there have been. */
  readonly badInRow: number;
  readonly worstRun: number;
  readonly worstMs: number;
  readonly secondsDark: number;
  /** Pages fetched under load, and how many of them were not a 200. */
  readonly pages: number;
  readonly pagesBad: number;
}

export const EMPTY: Tally = { probes: 0, non200: 0, badInRow: 0, worstRun: 0, worstMs: 0, secondsDark: 0, pages: 0, pagesBad: 0 };

export const isBad = (p: Probe): boolean => p.status !== 200 || p.ms > SLOW_MS;

/** The tally with one more `/healthz` probe. */
export function tally(t: Tally, p: Probe): Tally {
  const bad = isBad(p);
  const badInRow = bad ? t.badInRow + 1 : 0;
  return {
    ...t,
    probes: t.probes + 1,
    non200: t.non200 + (p.status === 200 ? 0 : 1),
    badInRow,
    worstRun: Math.max(t.worstRun, badInRow),
    worstMs: Math.max(t.worstMs, Math.round(p.ms)),
    secondsDark: t.secondsDark + (p.status === 200 ? 0 : 1),
  };
}

/** The tally with one more page fetched under load; its latency counts toward the worst. */
export function tallyPage(t: Tally, p: Probe): Tally {
  return { ...t, pages: t.pages + 1, pagesBad: t.pagesBad + (isBad(p) ? 1 : 0), worstMs: Math.max(t.worstMs, Math.round(p.ms)) };
}

export const failed = (t: Tally): boolean => t.worstRun >= FAIL_AFTER;

/** Why a failed tally failed, with its numbers, in one line. */
export function failure(t: Tally): string {
  return `${t.worstRun} bad /healthz probes in a row (non-200 or over ${SLOW_MS / 1000} s) after ${t.probes} probes; ${t.non200} non-200, worst ${t.worstMs} ms`;
}

export interface VerifyPorts {
  /** One GET: the status (0 when nothing answered) and how long it took. */
  readonly get: (path: string, asAdmin: boolean) => Promise<Probe>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** The pages fetched in turn, one at a time. */
  readonly pages: readonly string[];
  readonly durationMs?: number;
  /** Told after each probe, so the record keeps up while the verify runs. */
  readonly onProbe?: (t: Tally) => void;
}

export type Verdict = { readonly ok: boolean; readonly tally: Tally; readonly reason: string };

/** Probe `/healthz` each second under page load until the time is up or three bad probes in a row fail it. */
export async function verifyUnderLoad(ports: VerifyPorts, start: Tally = EMPTY): Promise<Verdict> {
  const end = ports.now() + (ports.durationMs ?? VERIFY_MS);
  let t = start;
  let stop = false;
  // The load: one page at a time, the next when the last has answered.
  const load = (async () => {
    for (let i = 0; !stop && ports.pages.length > 0; i++) {
      const page = await ports.get(ports.pages[i % ports.pages.length]!, true);
      t = tallyPage(t, page);
      if (ports.now() >= end) break;
    }
  })();
  while (ports.now() < end) {
    const began = ports.now();
    t = tally(t, await ports.get("/healthz", false));
    ports.onProbe?.(t);
    if (failed(t)) break;
    await ports.sleep(Math.max(0, PROBE_EVERY_MS - (ports.now() - began)));
  }
  stop = true;
  await load;
  return failed(t) ? { ok: false, tally: t, reason: failure(t) } : { ok: true, tally: t, reason: "" };
}

/** A GET through `fetch` that never throws: a refused connection or a timeout is status 0. */
export function timedGet(
  base: string,
  headers: (asAdmin: boolean) => Record<string, string>,
  fetcher: typeof fetch = fetch,
  now: () => number = () => performance.now(),
): (path: string, asAdmin: boolean) => Promise<Probe> {
  return async (path, asAdmin) => {
    const began = now();
    try {
      const res = await fetcher(new URL(path, base), {
        headers: headers(asAdmin),
        redirect: "manual",
        signal: AbortSignal.timeout(SLOW_MS + 5000),
      });
      await res.arrayBuffer();
      return { status: res.status, ms: now() - began };
    } catch {
      return { status: 0, ms: now() - began };
    }
  };
}
