/**
 * What a repository's code reached without declaring it, while egress is
 * only reported (`cells.egress` = `report`, `core/capacity.ts`): one small
 * file per repository under `<data>/egress/`, read by the app's page so its
 * writers know what to add to `forge.json` before egress is enforced.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defect } from "../kernel/error.ts";
import { hostAllowed } from "./egress.ts";

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

/**
 * What `repoId`'s code reached that `declared` does not allow, and the
 * `egress` entries to add to `forge.json` (a port is named unless 80 or 443).
 * The app's page and the terminal both say it from here.
 */
export function undeclaredHosts(
  dataDir: string,
  repoId: string,
  declared: readonly string[],
): { reached: Reached[]; entries: string[] } {
  const reached = reachedHosts(dataDir, repoId).filter((r) => !hostAllowed(declared, r.host, r.port));
  const entries = [
    ...new Set(reached.map((r) => (r.port === 80 || r.port === 443 ? r.host : `${r.host}:${r.port}`))),
  ];
  return { reached, entries };
}

/** Whether those calls still work, by the forge's egress mode. */
export function egressModeSentence(mode: "enforce" | "report"): string {
  return mode === "report"
    ? "They were let through while egress is only reported; once it is enforced they are refused."
    : "They were let through while egress was only reported; they are refused now.";
}
