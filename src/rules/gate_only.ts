/**
 * Gate-only reds (#7560): a test that failed in a merge-queue gate while the
 * pull the gate carried had passed its own check. Two such gates in a week
 * file one issue naming the test and what differs; one files none. The pull's
 * own check is its latest finished `check` run: green (`ok`) means every test
 * it ran passed there. Reads `gate_result` (kept a week) and `run`.
 */

import type { Database } from "bun:sqlite";
import type { EventBus } from "../core/events.ts";
import type { Repo } from "../core/repos.ts";
import { fileIssueOnce } from "../checks/flake.ts";
import { RULE_TESTS } from "../checks/tiers.ts";

export const WINDOW_MS = 7 * 24 * 3_600_000;
export const FILE_AT = 2;

export interface GateOnly {
  readonly repoId: string;
  readonly test: string;
  readonly file: string;
  /** Gates that failed it while their pulls' own checks were green. */
  readonly gates: readonly { readonly id: string; readonly pulls: readonly number[] }[];
}

interface GateRow {
  id: string;
  repo_id: string;
  pulls: string;
  tests: string;
}

const numbers = (raw: string): number[] => {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((n): n is number => Number.isInteger(n)) : [];
  } catch {
    return [];
  }
};

function failing(raw: string): { name: string; file: string }[] {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((t: { name?: unknown; file?: unknown }) =>
      typeof t?.name === "string" ? [{ name: t.name, file: typeof t.file === "string" ? t.file : "" }] : [],
    );
  } catch {
    return [];
  }
}

/** The red gates of the week: `?1` = the week's start (ISO). */
export const GATE_RED_SQL = "SELECT id, repo_id, pulls, tests FROM gate_result WHERE state = 'red' AND finished_at >= ?1 ORDER BY id";

/**
 * The latest finished own check of every pull the gates carried, in one read:
 * `?1` = the repository ids, `?2` = the pull numbers, both as JSON arrays.
 * Keyed `repoId#number`; true when it was green.
 */
export const OWN_CHECK_SQL = `SELECT i.repo_id AS repo_id, i.number AS number,
         (SELECT c.state FROM run c WHERE c.issue_id = i.id AND c.kind = 'check' AND c.state IN ('ok','failed')
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS state
    FROM issue i
   WHERE i.kind = 'pull' AND i.repo_id IN (SELECT value FROM json_each(?1)) AND i.number IN (SELECT value FROM json_each(?2))`;

function ownChecksGreen(db: Database, repoIds: readonly string[], numbers: readonly number[]): Set<string> {
  if (numbers.length === 0) return new Set();
  const rows = db
    .query<{ repo_id: string; number: number; state: string | null }, [string, string]>(OWN_CHECK_SQL)
    .all(JSON.stringify(repoIds), JSON.stringify(numbers));
  return new Set(rows.filter((r) => r.state === "ok").map((r) => `${r.repo_id}#${r.number}`));
}

/** The tests that are gate-only red at least once in the week, with the gates that showed it. */
export function gateOnlyReds(db: Database, now: number): GateOnly[] {
  const rows = db.query<GateRow, [string]>(GATE_RED_SQL).all(new Date(now - WINDOW_MS).toISOString());
  const carried = rows.map((g) => ({ g, pulls: numbers(g.pulls) }));
  const green = ownChecksGreen(
    db,
    [...new Set(rows.map((g) => g.repo_id))],
    [...new Set(carried.flatMap((c) => c.pulls))],
  );
  const by = new Map<string, { repoId: string; test: string; file: string; gates: { id: string; pulls: number[] }[] }>();
  for (const { g, pulls } of carried) {
    // A gate whose pulls were not all green on their own: its red is a pull's, not the gate's.
    if (pulls.length === 0 || !pulls.every((n) => green.has(`${g.repo_id}#${n}`))) continue;
    for (const t of failing(g.tests)) {
      const key = `${g.repo_id}\0${t.name}`;
      const at = by.get(key) ?? { repoId: g.repo_id, test: t.name, file: t.file, gates: [] };
      at.gates.push({ id: g.id, pulls });
      by.set(key, at);
    }
  }
  return [...by.values()];
}

export const gateOnlyTitle = (test: string): string => `Gate-only red: ${test.slice(0, 200)}`;

/** Say what the pull's check did not run, from the rule set it always runs. */
function differs(file: string): string {
  if (file !== "" && RULE_TESTS.includes(file))
    return `\`${file}\` is in the pull check's rule set (the #7138 class) yet passed there: look for what the gate adds, the other pulls' changes in one candidate tree, or its load and file order.`;
  return `${file === "" ? "The test's file is unknown" : `\`${file}\` is not in the pull check's rule set`}: the pull's fast check runs the tests its diff reaches, so a repo-wide scan, an ordering or a load-sensitive step shows only in the gate (#7138, #7354).`;
}

/** File one issue per test that was gate-only red {@link FILE_AT} times or more in the week; returns the numbers opened. */
export function fileGateOnly(db: Database, bus: EventBus, repos: ReadonlyMap<string, Pick<Repo, "id" | "ownerId">>, now: number): number[] {
  const opened: number[] = [];
  for (const g of gateOnlyReds(db, now)) {
    const repo = repos.get(g.repoId);
    if (repo === undefined || g.gates.length < FILE_AT) continue;
    const shown = g.gates.slice(0, 5).map((x) => `gate ${x.id} (${x.pulls.length === 1 ? "pull" : "pulls"} ${x.pulls.map((n) => `#${n}`).join(", ")})`).join(", ");
    const filed = fileIssueOnce(db, bus, repo, {
      title: gateOnlyTitle(g.test),
      body:
        `_Filed by the rule watcher from the gate record, not written by a person._\n\n` +
        `\`${g.test}\` failed in ${g.gates.length} merge-queue gates this week while each carried pull's own check was green: ${shown}.\n\n` +
        `${differs(g.file)}\n\nMake it deterministic or budget-aware; do not quarantine it.` +
        (g.file === "" ? "" : `\n\nFiles: ${g.file}`),
    });
    if (filed.opened) opened.push(filed.number);
  }
  return opened;
}
