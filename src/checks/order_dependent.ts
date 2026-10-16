/**
 * A test file that failed in a sliced shard and passed alone is cleared by
 * the gate (`scripts/shards.ts`), which says so in the check log: `fails only
 * beside others: <files> (shard-mates: <files>)`. Cleared is not fixed (#2480):
 * an order-dependent failure must be tracked. The check cell cannot reach the
 * forge API, so the runner that holds the check's output files it: one open
 * issue per file, a comment on it when the file shows up again.
 *
 * Plain data in (the lines), the issue and the comment out.
 */

import type { Database } from "bun:sqlite";
import { addComment, createIssue } from "../core/issues.ts";
import type { Repo } from "../core/repos.ts";
import type { EventBus } from "../core/events.ts";

export interface OrderDependent {
  readonly file: string;
  readonly mates: readonly string[];
}

const LINE = /fails only beside others: (.+?) \(shard-mates: (.*)\)\s*$/;

/** A file name is a repository path; anything else in the log is not filed. */
const PATH = /^[\w@./+-]{1,200}$/;

/** The log is the branch's own output: bound what one run may file. */
export const MAX_FILED = 5;
const MAX_NAMES = 50;
const MAX_LINE = 8_000;

const names = (list: string): string[] =>
  list.split(",", MAX_NAMES).map((s) => s.trim()).filter((s) => PATH.test(s));

const MAX_SEEN = 500;

/** Every file the log's verdict lines cleared, once each, bounded by {@link MAX_SEEN}. */
export function clearedFiles(lines: readonly string[]): OrderDependent[] {
  const seen = new Map<string, OrderDependent>();
  for (const line of lines) {
    if (seen.size >= MAX_SEEN) break;
    const m = LINE.exec(line.slice(0, MAX_LINE));
    if (m === null) continue;
    const mates = m[2] === "none" ? [] : names(m[2] ?? "");
    for (const file of names(m[1] ?? "")) {
      if (seen.size < MAX_SEEN && !seen.has(file)) seen.set(file, { file, mates });
    }
  }
  return [...seen.values()];
}

/** The files to file: the first {@link MAX_FILED} cleared. */
export const orderDependent = (lines: readonly string[]): OrderDependent[] =>
  clearedFiles(lines).slice(0, MAX_FILED);

/** The machine says so: the author is the owner, the text is not theirs. */
const FILED_BY = "_Filed by the check runner from a check log, not written by a person._";

export const titleOf = (file: string): string => `Test fails only beside others: ${file}`;

/**
 * Open an issue for each cleared file, or comment on the one already open.
 * Returns the issue numbers touched. Never throws into the check.
 */
export function fileOrderDependent(
  db: Database,
  bus: EventBus,
  repo: Pick<Repo, "id" | "ownerId">,
  found: readonly OrderDependent[],
  ref: { runId: string; commit: string },
): number[] {
  const touched: number[] = [];
  for (const { file, mates } of found) {
    const title = titleOf(file);
    const evidence =
      `${FILED_BY}\n\nCheck run ${ref.runId} (${ref.commit.slice(0, 7)}): \`${file}\` failed in its shard and passed when run alone.\n\n` +
      `Shard-mates: ${mates.length === 0 ? "none" : mates.map((m) => `\`${m}\``).join(", ")}`;
    const open = db
      .query<{ id: string; number: number }, [string, string]>(
        "SELECT id, number FROM issue WHERE repo_id = ?1 AND title = ?2 AND state = 'open' LIMIT 1",
      )
      .get(repo.id, title);
    if (open !== null) {
      if (addComment(db, { issueId: open.id, authorId: repo.ownerId, body: evidence }).ok)
        touched.push(open.number);
      continue;
    }
    const made = createIssue(db, {
      repoId: repo.id,
      authorId: repo.ownerId,
      title,
      body:
        `The gate cleared this test file because it passed alone, so the check stayed green. ` +
        `An order-dependent failure is still a failure: find what it shares with its shard-mates.\n\n${evidence}`,
    });
    if (!made.ok) continue;
    bus.append({
      kind: "issue.opened",
      repoId: repo.id,
      actorId: repo.ownerId,
      payload: { number: made.value.number },
    });
    touched.push(made.value.number);
  }
  return touched;
}
