/**
 * When the release keeper cuts (#7557): plain data in, one answer out.
 *
 *   cut ⇔ main ≠ the newest tag's commit
 *       ∧ no release of the keeper's is in flight (cut, rolling, verifying)
 *       ∧ the live version is the newest tag's, or the keeper rolled that
 *         tag back (nothing still promoting)
 *       ∧ no merge-queue gate is running (the queue is not mid-landing)
 *       ∧ no snapshot is being taken, unless it has run `SNAPSHOT_WAIT_MS`
 *       ∧ now − the last cut ≥ the minimum interval
 *       ∧ no hold stands (a failed verify's, or an owner's)
 *
 * The first rule that refuses names itself, so the record says why not.
 * The version is the newest tag's with its patch number plus one.
 */

/** Two releases are at least this far apart: 30 minutes. */
export const MIN_INTERVAL_MS = 30 * 60_000;

/**
 * A release drains the process a snapshot runs in, so a cut waits for the
 * snapshot (#9653: swaps every few minutes cut the nightly short all
 * morning, and the newest snapshot went 27 h old). One running longer than
 * this is stuck, and holds releases no more.
 */
export const SNAPSHOT_WAIT_MS = 2 * 3_600_000;

export interface CadenceInput {
  /** main's head commit. */
  readonly main: string;
  /** The newest release tag: its version and the commit it names. */
  readonly newest: { readonly version: string; readonly sha: string } | undefined;
  /** The version this forge runs. */
  readonly live: string;
  /** The keeper rolled the newest tag back: it is over, not promoting. */
  readonly settled?: boolean;
  /** A keeper release not yet verified or rolled back. */
  readonly inFlight: boolean;
  /** Merge-queue gates running now. */
  readonly gating: number;
  /** How long the snapshot being taken has run, ms; undefined when none is. */
  readonly snapshotMs?: number | undefined;
  /** When the keeper last cut, epoch ms. */
  readonly lastCutAt: number | undefined;
  /** The reason of a standing hold, when one stands. */
  readonly hold: string | undefined;
  readonly now: number;
  readonly minIntervalMs?: number;
}

export type Cadence = { readonly cut: true; readonly version: string } | { readonly cut: false; readonly why: string };

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** The next patch version: `0.7.283` → `0.7.284`; undefined when `version` is not major.minor.patch. */
export function nextVersion(version: string): string | undefined {
  const m = SEMVER.exec(version);
  if (m === null) return undefined;
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export function decideCut(input: CadenceInput): Cadence {
  const no = (why: string): Cadence => ({ cut: false, why });
  if (input.hold !== undefined) return no(`held: ${input.hold}`);
  if (input.newest === undefined) return no("no release tag to follow; cut the first one by hand");
  if (input.main === input.newest.sha) return no(`main is still ${input.newest.version}`);
  if (input.inFlight) return no("a release is still rolling or being verified");
  if (input.live !== input.newest.version && input.settled !== true) return no(`${input.newest.version} is not live yet (live: ${input.live})`);
  if (input.gating > 0) return no(`the merge queue is landing (${input.gating} gate${input.gating === 1 ? "" : "s"} running)`);
  if (input.snapshotMs !== undefined && input.snapshotMs < SNAPSHOT_WAIT_MS)
    return no(`a snapshot is being taken (${Math.floor(input.snapshotMs / 60_000)} min in); a release would cut it short`);
  const wait = input.minIntervalMs ?? MIN_INTERVAL_MS;
  if (input.lastCutAt !== undefined && input.now - input.lastCutAt < wait)
    return no(`the last cut was ${Math.floor((input.now - input.lastCutAt) / 60_000)} min ago; the interval is ${wait / 60_000} min`);
  const version = nextVersion(input.newest.version);
  if (version === undefined) return no(`${input.newest.version} is not major.minor.patch`);
  return { cut: true, version };
}
