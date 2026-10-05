/**
 * What a repository's code reached without declaring it, while egress is
 * only reported (`FORGE_CELLS_EGRESS=report`, `apps/contain.ts`): one small
 * file per repository under `<data>/egress/`, read by the app's page so its
 * writers know what to add to `forge.json` before egress is enforced.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defect } from "../kernel/error.ts";

export interface Reached {
  readonly host: string;
  readonly port: number;
  readonly count: number;
  /** When it was last reached (ISO). */
  readonly last: string;
}

/** At most this many hosts are kept per repository; the rest are dropped. */
const HOSTS_MAX = 50;

function fileFor(dataDir: string, repoId: string): string {
  if (!/^[0-9a-z]+$/i.test(repoId))
    defect("apps.bad_egress_path", `refusing to build a path for ${repoId}`);
  return join(dataDir, "egress", `${repoId}.json`);
}

/** The hosts `repoId`'s code reached undeclared, most recent first. */
export function reachedHosts(dataDir: string, repoId: string): Reached[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(fileFor(dataDir, repoId), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Reached =>
        typeof r === "object" &&
        r !== null &&
        typeof (r as Reached).host === "string" &&
        typeof (r as Reached).port === "number" &&
        typeof (r as Reached).count === "number" &&
        typeof (r as Reached).last === "string",
    );
  } catch {
    return [];
  }
}

/** Count one undeclared connection from `repoId`'s code to `host:port`. */
export function noteReached(
  dataDir: string,
  repoId: string,
  host: string,
  port: number,
): void {
  const file = fileFor(dataDir, repoId);
  const now = new Date().toISOString();
  const seen = reachedHosts(dataDir, repoId);
  const prior = seen.find((r) => r.host === host && r.port === port);
  const next = [
    { host, port, count: (prior?.count ?? 0) + 1, last: now },
    ...seen.filter((r) => r !== prior),
  ].slice(0, HOSTS_MAX);
  mkdirSync(join(dataDir, "egress"), { recursive: true });
  writeFileSync(`${file}.new`, JSON.stringify(next));
  renameSync(`${file}.new`, file);
}
