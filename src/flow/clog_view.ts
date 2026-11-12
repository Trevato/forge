/**
 * What clogs the lane (#11454), read once for /flow and its terminal screen: one sentence (`clogSays`), a test failing on three or more open
 * pulls shown once (`sharedRed`), and pairs of open pulls touching the same files (`conflictPairs`, at most 20). Read from the runs table and
 * the pull file lists `crew/hot_files.ts` keeps in memory; no git per request. Quiet is an empty sentence and empty lists.
 */

import type { Database } from "bun:sqlite";
import { learnedPulls, warmFiles } from "../crew/hot_files.ts";
import { getRepoById } from "../core/repos.ts";
import { clogSays } from "./clog_words.ts";
import { readClog } from "./clog_read.ts";
import { conflictPairs } from "./conflict_pairs.ts";
import { conflictedPulls } from "./conflicted.ts";
import { sharedRed } from "./shared_red.ts";
import { readStranded } from "./stranded.ts";
import { approvedRows } from "../web/pages/flow-waiting.ts";

export interface ClogView {
  readonly says: string;
  readonly shared: readonly { test: string; pulls: readonly { repo: string; number: number }[] }[];
  readonly pairs: readonly { a: Ref; b: Ref; shared: number }[];
}
type Ref = { repo: string; number: number };

/** The latest check of each open pull that failed, with the tests it named. */
function failingRows(db: Database): { repo: string; number: number; tests: string[] }[] {
  return db
    .query<{ repo: string; number: number; detail: string }, []>(
      `SELECT o.username || '/' || r.name AS repo, i.number AS number, u.check_detail AS detail
         FROM pull p JOIN issue i ON i.id = p.issue_id AND i.state = 'open'
         JOIN repo r ON r.id = i.repo_id JOIN user o ON o.id = r.owner_id
         JOIN run u ON u.id = (SELECT n.id FROM run n WHERE n.issue_id = i.id AND n.kind = 'check' ORDER BY n.id DESC LIMIT 1)
        WHERE p.merged_at IS NULL AND u.state = 'failed' AND json_valid(u.check_detail)`,
    )
    .all()
    .map((x) => {
      const names = (JSON.parse(x.detail) as { names?: unknown }).names;
      return { repo: x.repo, number: x.number, tests: Array.isArray(names) ? names.filter((n): n is string => typeof n === "string" && n !== "") : [] };
    });
}

export function readClogView(db: Database, now = new Date()): ClogView {
  const failing = failingRows(db);
  const key = (r: Ref): string => `${r.repo}#${r.number}`;
  // sharedRed counts pull numbers; distinct repositories reuse numbers, so each pull gets a forge-wide one.
  const ids = new Map<string, number>();
  const refs: Ref[] = [];
  const idOf = (r: Ref): number => {
    let n = ids.get(key(r));
    if (n === undefined) ids.set(key(r), (n = refs.push(r)));
    return n;
  };
  const shared = sharedRed(failing.map((f) => ({ pull: idOf(f), failingTests: f.tests }))).map((s) => ({
    test: s.test,
    pulls: s.pulls.map((n) => refs[n - 1]!),
  }));

  const names = new Map<string, string>();
  const nameOf = (repoId: string): string => {
    let n = names.get(repoId);
    if (n === undefined) {
      const r = getRepoById(db, repoId);
      names.set(repoId, (n = r ? `${r.ownerName}/${r.name}` : ""));
    }
    return n;
  };
  const learned = learnedPulls().filter((p) => nameOf(p.repoId) !== "");
  const byRepo = new Map<string, { number: number; files: readonly string[] }[]>();
  for (const p of learned) (byRepo.get(p.repoId) ?? byRepo.set(p.repoId, []).get(p.repoId)!).push(p);
  const pairs = [...byRepo].flatMap(([repoId, pulls]) => conflictPairs(pulls).map((c) => ({ a: { repo: nameOf(repoId), number: c.a }, b: { repo: nameOf(repoId), number: c.b }, shared: c.shared })));
  pairs.sort((p, q) => q.shared - p.shared || key(p.a).localeCompare(key(q.a)));

  const approved = new Set(approvedRows(db).map(key));
  const conflicted = conflictedPulls(db).filter((c) => approved.has(key(c))).length;
  const hot = warmFiles().sort((a, b) => b.pulls - a.pulls || a.path.localeCompare(b.path))[0];
  const standing = readClog(db, now).standing;
  const says = clogSays({
    reasons: standing?.reasons ?? [],
    conflictedApproved: conflicted,
    hottest: hot,
    strandedUsd: readStranded(db).usd,
  });
  return { says: shared.length > 0 || pairs.length > 0 || standing || conflicted > 0 ? says : "", shared, pairs: pairs.slice(0, 20) };
}


/** The clog as terminal lines: the sentence, then one line per shared test and per pair; none when quiet. */
export function clogViewLines(v: ClogView, inner: number, wrap: (s: string, w: number) => string[]): string[] {
  if (v.says === "" && v.shared.length === 0 && v.pairs.length === 0) return [];
  const ref = (r: Ref): string => `${r.repo} #${String(r.number)}`;
  return [
    "",
    ...(v.says === "" ? [] : wrap(v.says, inner)),
    ...v.shared.flatMap((s) => wrap(`${s.test} fails on ${String(s.pulls.length)} open pulls: ${s.pulls.map(ref).join(", ")}`, inner)),
    ...v.pairs.flatMap((c) => wrap(`${ref(c.a)} and ${ref(c.b)}: ${String(c.shared)} shared ${c.shared === 1 ? "file" : "files"}`, inner)),
  ];
}
