/**
 * A release shipped by hand is still a release (#11955). When the steward tags, builds the image on
 * the host and restarts the container with `FORGE_VERSION` and `FORGE_COMMIT` set, the keeper cut
 * nothing, and `keeper_release` knew of none, so "live" could not resolve. At boot a forge whose
 * stamp is newer than the newest release that served records itself: version, commit, went live =
 * the boot time, `how` = "by hand". The same stamp is what `/changelog` reads
 * (`kernel/version.ts`).
 * A forge with no stamp, a preview (its stamp is not inherited) or one running an older version
 * than the record records nothing.
 */
import type { Database } from "bun:sqlite";
import { running } from "../kernel/version.ts";

const NUMERIC = /^\d+(?:\.\d+){0,3}$/;

/**
 * Dotted numbers compared part by part: negative when `a` is older; undefined when either is not
 * dotted numbers.
 */
export function compareVersions(a: string, b: string): number | undefined {
  if (!NUMERIC.test(a) || !NUMERIC.test(b)) return undefined;
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The version recorded, or undefined when this boot records nothing. */
export function recordByHand(
  db: Database,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): string | undefined {
  const stamp = running({ FORGE_VERSION: env["FORGE_VERSION"], FORGE_COMMIT: env["FORGE_COMMIT"] });
  if (stamp.commit === null || !NUMERIC.test(stamp.version)) return undefined;
  const served = db
    .query<{ version: string }, []>(`SELECT version FROM keeper_release WHERE live_at IS NOT NULL AND stage != 'rolled_back'`)
    .all();
  if (served.some((r) => r.version.replace(/^v(?=\d)/, "") === stamp.version)) return undefined;
  if (served.some((r) => (compareVersions(stamp.version, r.version.replace(/^v(?=\d)/, "")) ?? 0) < 0)) return undefined;
  const at = now.toISOString();
  const made = db
    .query(
      `INSERT OR IGNORE INTO keeper_release (version, sha, known_good_version, known_good_image, stage, cut_at, live_at, finished_at, reason, how)
       VALUES (?1, ?2, '', '', 'verified', ?3, ?3, ?3, 'recorded at boot: shipped by hand', 'by hand')`,
    )
    .run(stamp.version, stamp.commit, at);
  return made.changes === 1 ? stamp.version : undefined;
}
