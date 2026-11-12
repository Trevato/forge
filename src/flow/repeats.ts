/**
 * A reviewer's repeated comment becomes a check (#8716). Review findings of
 * the last week — the lines of a review that asked for changes and the line
 * comments on a diff — are grouped by the words they ask with: no agent run,
 * one read of two indexed tables. A finding seen {@link REPEATS} times in the
 * week is proposed once as an issue to automate it as a lint or test, naming
 * the comments. When that issue is done the finding is retired, and the
 * week's review comments per pull are shown beside it, this week and last.
 */

import type { Database } from "bun:sqlite";
import { sliced } from "../kernel/breathe.ts";

const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;

/** Times a finding repeats in a week before a check is proposed (Boris's "3 or 4"). */
export const REPEATS = 4;
/** Words two findings share, of all their words, to be one finding. */
const SAME = 0.5;
const MIN_WORDS = 3;
const MAX_LINES = 20;
const MAX_LINE = 400;
const MAX_NAMED = 8;

const STOP = new Set(
  "the and for that this with from not are was but you your can could should would please into when then than there their have has had its use using used also one any all too more instead need needs make sure still does doesn".split(
    " ",
  ),
);

export interface Finding {
  readonly repo: string;
  readonly pull: number;
  readonly author: string;
  readonly authorId: string;
  readonly text: string;
}

export interface Group {
  readonly key: string;
  readonly sample: string;
  readonly findings: Finding[];
}

/** The words a finding asks with: no code, links or numbers, crudely stemmed. */
export function wordsOf(text: string): string[] {
  const plain = text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w./-]+\.(?:ts|js|md|json|css)\b/g, " ");
  const out = new Set<string>();
  for (const w of plain.match(/[a-z]{3,}/g) ?? []) {
    const stem = w.replace(/(?:ing|ed|es|s)$/, "");
    if (stem.length >= 3 && !STOP.has(w) && !STOP.has(stem)) out.add(stem);
  }
  return [...out].sort();
}

/**
 * Rule "a lead-in is not a finding" (#8838): a line whose text, bare of
 * bold/italic markers and trailing space, ends in a colon introduces the list
 * that follows and asks for nothing: `Smaller points:`, `**Smaller points:**`,
 * `_Fix in the same round:_`.
 */
export const isLeadIn = (line: string): boolean =>
  line.replace(/^[\s*_]+|[\s*_]+$/g, "").endsWith(":");

const COUNT = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:things?|points?|issues?|fix(?:es)?|notes?)\b/i;

/**
 * Rule "a count is not a finding" (#9322), beside #8838's: a line that only
 * counts or orders what follows opens a review and asks for nothing: "Two
 * things to fix, first one first.", "Three points, one round." It starts with a
 * number word or digit and things/points/issues/fixes/notes, names no code (no
 * backtick, no path) and is under 80 characters. "Two tests share a port; give
 * each its own" is kept: it says what to change.
 */
export const isCount = (line: string): boolean => {
  const bare = line.replace(/^[\s*_]+|[\s*_]+$/g, "");
  return bare.length < 80 && !bare.includes("`") && !/[\w-]\/[\w-]|\.(?:ts|js|md|json|css)\b/.test(bare) && COUNT.test(bare);
};

/**
 * The findings in one review body: its list items or lines, each a request.
 * A line that ends in a colon introduces the list that follows ("Smaller
 * points, fix in the same round:"), asks for nothing, and is dropped: as a
 * finding it repeated across every review that used it (#8838). So is a line
 * that only counts what follows ("Two things to fix, first one first.", #9322).
 */
export function linesOf(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter((l) => l.length >= 12 && !isLeadIn(l) && !isCount(l))
    .slice(0, MAX_LINES)
    .map((l) => l.slice(0, MAX_LINE));
}

const similar = (a: readonly string[], b: readonly string[]): boolean => {
  const inter = a.filter((w) => b.includes(w)).length;
  return inter / (a.length + b.length - inter) >= SAME;
};

/**
 * Findings grouped by what they ask for, the largest group first. A finding joins
 * the first group it is {@link similar} to; the groups are found through a word
 * index, not by comparing against every one (#8848: that was quadratic, 46 s on a
 * week of findings). Two findings are the same only when they share at least half
 * of the finding's words (Jaccard ≥ 0.5 needs |a∩b| ≥ |a|/2), so probing any
 * |a| − ⌈|a|/2⌉ + 1 of its words, the rarest first, meets every group that can match.
 */
export function group(findings: readonly Finding[]): Group[] {
  const grouper = newGrouper();
  for (const f of findings) grouper.add(f);
  return grouper.done();
}

/** {@link group}, handing the thread back between slices: a week of findings is thousands. */
export async function groupSliced(findings: readonly Finding[]): Promise<Group[]> {
  const grouper = newGrouper();
  const slice = sliced();
  for (const f of findings) {
    grouper.add(f);
    if (slice.due()) await slice.breathe();
  }
  return grouper.done();
}

function newGrouper(): { add(f: Finding): void; done(): Group[] } {
  const groups: { words: string[]; set: Set<string>; pulls: Set<string>; g: Group }[] = [];
  const postings = new Map<string, number[]>();
  return {
    add(f) {
      const words = wordsOf(f.text);
      if (words.length < MIN_WORDS) return;
      const probe = words
        .map((w) => [w, postings.get(w)] as const)
        .sort((a, b) => (a[1]?.length ?? 0) - (b[1]?.length ?? 0))
        .slice(0, words.length - Math.ceil(words.length / 2) + 1);
      const candidates = new Set<number>();
      for (const [, ids] of probe) for (const id of ids ?? []) candidates.add(id);
      let hit: (typeof groups)[number] | undefined;
      for (const id of [...candidates].sort((a, b) => a - b)) {
        const x = groups[id]!;
        const inter = words.filter((w) => x.set.has(w)).length;
        if (inter / (x.words.length + words.length - inter) >= SAME) {
          hit = x;
          break;
        }
      }
      // a pull says a finding once: its review body and its line comments are one ask
      if (hit) {
        if (!hit.pulls.has(`${f.repo}#${f.pull}`)) {
          hit.pulls.add(`${f.repo}#${f.pull}`);
          hit.g.findings.push(f);
        }
      } else {
        const id = groups.length;
        groups.push({ words, set: new Set(words), pulls: new Set([`${f.repo}#${f.pull}`]), g: { key: words.join(" "), sample: f.text, findings: [f] } });
        for (const w of words) {
          const ids = postings.get(w);
          if (ids) ids.push(id);
          else postings.set(w, [id]);
        }
      }
    },
    done: () => groups.map((x) => x.g).sort((a, b) => b.findings.length - a.findings.length),
  };
}

interface Row {
  repo: string;
  number: number;
  author: string;
  authorId: string;
  body: string;
}

/** The reviewers' findings on a repository's pulls created in `[from, to)`. */
export function findingsIn(db: Database, repoId: string, from: Date, to: Date, publicOnly = false): Finding[] {
  const range = [from.toISOString(), to.toISOString(), repoId, publicOnly ? 1 : 0];
  const reviews = db
    .query<Row, (string | number)[]>(
      `SELECT issue.repo_id AS repo, issue.number AS number, user.username AS author, user.id AS authorId, review.body AS body
         FROM review JOIN issue ON issue.id = review.issue_id JOIN user ON user.id = review.author_id JOIN repo ON repo.id = issue.repo_id
        WHERE review.created_at >= ?1 AND review.created_at < ?2 AND (?3 = '' OR issue.repo_id = ?3) AND (?4 = 0 OR repo.visibility = 'public')
          AND review.state = 'changes_requested' AND review.author_id != issue.author_id`,
    )
    .all(...range);
  const lines = db
    .query<Row, (string | number)[]>(
      `SELECT issue.repo_id AS repo, issue.number AS number, user.username AS author, user.id AS authorId, comment.body AS body
         FROM comment JOIN issue ON issue.id = comment.issue_id JOIN user ON user.id = comment.author_id JOIN repo ON repo.id = issue.repo_id
        WHERE comment.kind = 'review' AND comment.created_at >= ?1 AND comment.created_at < ?2
          AND (?3 = '' OR issue.repo_id = ?3) AND (?4 = 0 OR repo.visibility = 'public') AND comment.author_id != issue.author_id`,
    )
    .all(...range);
  return [...reviews, ...lines].flatMap((r) =>
    linesOf(r.body).map((text) => ({ repo: r.repo, pull: r.number, author: r.author, authorId: r.authorId, text })),
  );
}

/** Review comments per pull reviewed, in `[from, to)`: every finding line over the pulls they were on. */
export function perPull(db: Database, repoId: string, from: Date, to: Date, publicOnly = false): { comments: number; pulls: number; per: number } {
  const found = findingsIn(db, repoId, from, to, publicOnly);
  const pulls = new Set(found.map((f) => `${f.repo}#${f.pull}`)).size;
  return { comments: found.length, pulls, per: pulls === 0 ? 0 : Math.round((found.length / pulls) * 10) / 10 };
}

/** The issue body that asks for the check, naming the comments. */
export function proposalBody(g: Group, now: Date): string {
  const named = g.findings
    .slice(0, MAX_NAMED)
    .map((f) => `- #${f.pull} (${f.author}): ${f.text.replace(/\s+/g, " ")}`);
  return [
    `Reviewers asked for the same thing ${g.findings.length} times in the week to ${now.toISOString().slice(0, 10)}. Once a comment repeats, a check says it for them (#8716).`,
    "",
    ...named,
    ...(g.findings.length > MAX_NAMED ? [`- and ${g.findings.length - MAX_NAMED} more`] : []),
    "",
    "**Done when:**",
    "- [ ] A lint (`scripts/`) or a test that fails on exactly what these comments ask for, so a reviewer need not say it again.",
    "- [ ] The check names the rule in its failure message.",
    "",
    "Files: scripts/gate.ts, test/",
  ].join("\n");
}

export interface Proposed {
  readonly key: string;
  readonly sample: string;
  readonly seen: number;
  readonly issue: number;
  readonly retired: boolean;
}

export interface Repeats {
  /** Whose figures these are: every repository, or only the public ones. */
  readonly scope: string;
  readonly says: string;
  readonly proposed: number;
  readonly retired: number;
  readonly thisWeek: ReturnType<typeof perPull>;
  readonly lastWeek: ReturnType<typeof perPull>;
  readonly findings: Proposed[];
}

/**
 * Groups worth a check and not yet asked for: a stored finding whose words are
 * the same one is never proposed twice.
 */
export async function dueGroups(db: Database, repoId: string, now: Date): Promise<Group[]> {
  const kept = db
    .query<{ key: string }, [string]>(`SELECT key FROM review_finding WHERE repo_id = ?1`)
    .all(repoId)
    .map((r) => r.key.split(" "));
  return (await groupSliced(findingsIn(db, repoId, new Date(now.getTime() - WEEK_MS), now))).filter(
    (g) => g.findings.length >= REPEATS && !kept.some((k) => similar(k, g.key.split(" "))),
  );
}

/** Remember a finding once its issue is opened. */
export function keepFinding(db: Database, repoId: string, g: Group, issue: number, now: Date): void {
  db.query(
    `INSERT INTO review_finding (repo_id, key, sample, seen, issue_number, proposed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(repoId, g.key, g.sample.slice(0, MAX_LINE), g.findings.length, issue, now.toISOString());
}

/** Retire each finding whose issue was done: the check landed. How many were retired now. */
export function retireLanded(db: Database, repoId: string, now: Date): number {
  return db
    .query(
      `UPDATE review_finding SET retired_at = ?2
        WHERE repo_id = ?1 AND retired_at IS NULL AND issue_number IN
          (SELECT number FROM issue WHERE repo_id = ?1 AND state = 'closed' AND close_reason = 'done')`,
    )
    .run(repoId, now.toISOString()).changes;
}

/** The reading: findings proposed and retired, with the week's comments per pull and last week's. */
export function readRepeats(db: Database, repoId: string, now = new Date(), publicOnly = false): Repeats {
  const rows = db
    .query<{ key: string; sample: string; seen: number; issue_number: number; retired_at: string | null }, [string, number]>(
      `SELECT key, sample, seen, issue_number, retired_at FROM review_finding JOIN repo ON repo.id = review_finding.repo_id
        WHERE (?1 = '' OR review_finding.repo_id = ?1) AND (?2 = 0 OR repo.visibility = 'public') ORDER BY review_finding.id DESC`,
    )
    .all(repoId, publicOnly ? 1 : 0);
  const week = new Date(now.getTime() - WEEK_MS);
  const thisWeek = perPull(db, repoId, week, now, publicOnly);
  const lastWeek = perPull(db, repoId, new Date(week.getTime() - WEEK_MS), week, publicOnly);
  const retired = rows.filter((r) => r.retired_at !== null).length;
  const scope = repoId !== "" ? "this repository" : publicOnly ? "public repositories" : "all repositories";
  return {
    scope,
    says: `${scope}: ${rows.length} repeated finding${rows.length === 1 ? "" : "s"} proposed as checks, ${retired} retired; review comments per pull ${thisWeek.per} this week, ${lastWeek.per} last`,
    proposed: rows.length,
    retired,
    thisWeek,
    lastWeek,
    findings: rows.map((r) => ({ key: r.key, sample: r.sample, seen: r.seen, issue: r.issue_number, retired: r.retired_at !== null })),
  };
}
