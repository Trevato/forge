/**
 * Turning what an origin says into rows.
 *
 * Every write here is an upsert keyed on the origin's own stable id, never
 * on its number: numbers are per-repo, shared between issues and pulls, and
 * not stable under a repo transfer. That one choice is what makes the sync
 * loop's overlap window free — replaying five minutes of already-imported
 * items rewrites the same rows and changes nothing.
 *
 * Two conventions the whole feature rests on. An imported row's `author_id`
 * is the connecting user, so every join, permission check and "author or
 * writer" rule in the forge keeps working unchanged; the real author travels
 * beside it in `origin_author`, and both surfaces render *that*, with the
 * origin's mark. And a mirrored repo's issue numbers ARE the origin's, so
 * `#42` is one conversation on both sides — which means `repo.issue_seq`
 * has to be dragged up past every imported number, or a later native issue
 * would collide with one that has not been imported yet.
 */

import type { Database } from "bun:sqlite";
import type { Label } from "../core/issues.ts";
import { hashLine } from "../core/reviews.ts";
import type { Diff } from "../git/diff.ts";
import { isSafeOid, isSafeRef } from "../git/guard.ts";
import { id } from "../kernel/id.ts";
import type {
  RemoteComment,
  RemoteIssue,
  RemoteLabel,
  RemoteReview,
  RemoteReviewState,
} from "./types.ts";

/** Same caps as a native issue: an origin does not get to write a novel. */
const MAX_TITLE = 256;
const MAX_BODY = 65_536;

/**
 * Clamp, and drop the control bytes an origin has no business sending.
 * Newline, carriage return and tab survive (a body needs them); NUL,
 * escape and the rest do not — those are what turn a label name into a
 * terminal escape sequence in the TUI or a log line into two.
 */
const clamp = (text: string, limit: number): string => {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return clean.length > limit ? clean.slice(0, limit) : clean;
};

/** A short field — a title, a login, a label — on one line. */
const oneLine = (text: string, limit: number): string =>
  clamp(text.replace(/[\r\n\t]+/g, " "), limit).trim();

/** Branch and object ids an origin reports for a pull. They are stored for
 * `pullDiff` to resolve later, and every git call there re-checks them; an
 * unsafe one is stored as "" now so nothing downstream ever meets it. */
const safeBranch = (ref: string): string => (isSafeRef(ref) ? ref : "");
const safeOid = (oid: string): string => (isSafeOid(oid) ? oid : "");

export interface ImportedIssue {
  readonly issueId: string;
  readonly number: number;
  readonly kind: "issue" | "pull";
  /** True the first time we saw it — the signal that an event is warranted. */
  readonly created: boolean;
  /** True when the origin's copy was newer than ours and the row moved. */
  readonly changed: boolean;
  /** For a pull that just became merged, so the caller can say so. */
  readonly newlyMerged: boolean;
}

/**
 * Bring a repo's labels in line with the origin's. Labels are matched by
 * name (the thing a human types and the thing a write-through sends) while
 * carrying the origin's id for provenance; a label that exists locally under
 * the same name is adopted rather than duplicated.
 */
export function importLabels(
  db: Database,
  repoId: string,
  labels: readonly RemoteLabel[],
): Map<string, Label> {
  const byName = new Map<string, Label>();
  const write = db.transaction(() => {
    for (const label of labels) {
      const name = oneLine(label.name, MAX_TITLE);
      if (name === "") continue;
      const existing = db
        .query<
          { id: string; name: string; color: string },
          [string, string]
        >("SELECT id, name, color FROM label WHERE repo_id = ?1 AND name = ?2 COLLATE NOCASE")
        .get(repoId, name);
      if (existing) {
        db.query(
          "UPDATE label SET color = ?1, origin_remote_id = ?2 WHERE id = ?3",
        ).run(label.color, label.remoteId, existing.id);
        byName.set(name.toLowerCase(), {
          id: existing.id,
          name: existing.name,
          color: label.color,
        });
        continue;
      }
      const labelId = id();
      db.query(
        `INSERT INTO label (id, repo_id, name, color, origin_remote_id)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      ).run(labelId, repoId, name, label.color, label.remoteId);
      byName.set(name.toLowerCase(), { id: labelId, name, color: label.color });
    }
  });
  write();
  return byName;
}

/** A label by name, created on demand — an issue may carry one the label
 * list did not report yet (it was added between the two calls). */
function labelIdFor(db: Database, repoId: string, name: string): string {
  const existing = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM label WHERE repo_id = ?1 AND name = ?2 COLLATE NOCASE")
    .get(repoId, name);
  if (existing) return existing.id;
  const labelId = id();
  db.query(
    "INSERT INTO label (id, repo_id, name, color) VALUES (?1, ?2, ?3, ?4)",
  ).run(labelId, repoId, name, "6b7280");
  return labelId;
}

export interface ImportContext {
  readonly db: Database;
  readonly repoId: string;
  /** The connecting user: every imported row is attributed to them locally. */
  readonly actorId: string;
}

/**
 * Upsert one issue or pull. The origin's number becomes the local number,
 * and `repo.issue_seq` is dragged past it so a native issue opened later
 * cannot collide with an origin number we have not imported yet.
 */
export function importIssue(
  ctx: ImportContext,
  remote: RemoteIssue,
): ImportedIssue {
  const { db, repoId, actorId } = ctx;
  const kind: "issue" | "pull" = remote.pull === undefined ? "issue" : "pull";
  const title = oneLine(remote.title, MAX_TITLE) || `#${remote.number}`;
  const body = clamp(remote.body, MAX_BODY);
  const author = oneLine(remote.author, MAX_TITLE);
  const labelNames = remote.labels
    .map((name) => oneLine(name, MAX_TITLE))
    .filter((name) => name !== "");
  let created = false;
  let changed = false;
  let newlyMerged = false;
  let issueId = "";

  const write = db.transaction(() => {
    const existing =
      db
        .query<
          { id: string; updated_at: string; number: number },
          [string, string]
        >("SELECT id, updated_at, number FROM issue WHERE repo_id = ?1 AND origin_remote_id = ?2")
        .get(repoId, remote.remoteId) ??
      // A row imported before we stored ids, or one that raced us: the number
      // is unique per repo, so it identifies the same conversation.
      db
        .query<
          { id: string; updated_at: string; number: number },
          [string, number]
        >("SELECT id, updated_at, number FROM issue WHERE repo_id = ?1 AND number = ?2")
        .get(repoId, remote.number);

    if (existing) {
      issueId = existing.id;
      // The origin's own clock is the concurrency control: an out-of-order
      // job completing late cannot drag a row backwards.
      changed = remote.updatedAt >= existing.updated_at;
      db.query(
        `UPDATE issue SET title = ?1, body = ?2, state = ?3, updated_at = ?4,
           closed_at = ?5, origin_remote_id = ?6, origin_author = ?7,
           origin_html_url = ?8, synced_at = ?9
         WHERE id = ?10`,
      ).run(
        title,
        body,
        remote.state,
        remote.updatedAt,
        remote.closedAt,
        remote.remoteId,
        author,
        remote.htmlUrl,
        new Date().toISOString(),
        issueId,
      );
    } else {
      created = true;
      changed = true;
      issueId = id();
      db.query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id,
                            state, created_at, updated_at, closed_at,
                            origin_remote_id, origin_author, origin_html_url, synced_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      ).run(
        issueId,
        repoId,
        remote.number,
        kind,
        title,
        body,
        actorId,
        remote.state,
        remote.createdAt,
        remote.updatedAt,
        remote.closedAt,
        remote.remoteId,
        author,
        remote.htmlUrl,
        new Date().toISOString(),
      );
      db.query(
        "UPDATE repo SET issue_seq = MAX(issue_seq, ?1) WHERE id = ?2",
      ).run(remote.number, repoId);
    }

    // Labels: the origin's set, exactly, every time.
    const labelIds = labelNames.map((name) => labelIdFor(db, repoId, name));
    db.query("DELETE FROM issue_label WHERE issue_id = ?1").run(issueId);
    const link = db.query(
      "INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?1, ?2)",
    );
    for (const labelId of labelIds) link.run(issueId, labelId);

    if (remote.pull !== undefined) {
      const before = db
        .query<
          { merged_at: string | null },
          [string]
        >("SELECT merged_at FROM pull WHERE issue_id = ?1")
        .get(issueId);
      newlyMerged =
        remote.pull.mergedAt !== null && (before?.merged_at ?? null) === null;
      db.query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid,
                           merged_at, origin_head_repo)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (issue_id) DO UPDATE SET
           base_branch = excluded.base_branch,
           head_branch = excluded.head_branch,
           base_oid = excluded.base_oid,
           head_oid = excluded.head_oid,
           merged_at = excluded.merged_at,
           origin_head_repo = excluded.origin_head_repo`,
      ).run(
        issueId,
        safeBranch(remote.pull.baseBranch),
        safeBranch(remote.pull.headBranch),
        safeOid(remote.pull.baseOid),
        safeOid(remote.pull.headOid),
        remote.pull.mergedAt,
        oneLine(remote.pull.headRepo, MAX_TITLE),
      );
    }
  });
  write();

  return {
    issueId,
    number: remote.number,
    kind,
    created,
    changed,
    newlyMerged,
  };
}

/**
 * Upsert a thread's comments. Returns how many were new — the number a
 * `…​.commented` event is worth appending for, and nothing more.
 */
export function importComments(
  ctx: ImportContext,
  issueId: string,
  comments: readonly RemoteComment[],
): number {
  let added = 0;
  const write = ctx.db.transaction(() => {
    for (const remote of comments) {
      if (remote.remoteId === "") continue;
      const body = clamp(remote.body, MAX_BODY);
      const author = oneLine(remote.author, MAX_TITLE);
      const existing = ctx.db
        .query<
          { id: string },
          [string, string]
        >("SELECT id FROM comment WHERE issue_id = ?1 AND origin_remote_id = ?2")
        .get(issueId, remote.remoteId);
      if (existing) {
        ctx.db
          .query(
            "UPDATE comment SET body = ?1, updated_at = ?2, origin_author = ?3 WHERE id = ?4",
          )
          .run(body, remote.updatedAt, author, existing.id);
        continue;
      }
      ctx.db
        .query(
          `INSERT INTO comment (id, issue_id, author_id, body, created_at, updated_at,
                              origin_remote_id, origin_author)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .run(
          id(),
          issueId,
          ctx.actorId,
          body,
          remote.createdAt,
          remote.updatedAt,
          remote.remoteId,
          author,
        );
      added++;
    }
  });
  write();
  return added;
}

/**
 * Upsert a pull's inline review comments.
 *
 * The anchor is (path, side, line) plus a hash of that line's content, the
 * same scheme a native review uses — so an imported comment participates in
 * the same "did this line change under it?" check as any other. When the
 * diff we hold does not contain the anchored line (the head is a fork we
 * never fetched, or the origin re-based since), the comment is stored with
 * no content hash, which reads as `outdated` everywhere: honest, and never
 * a comment silently landing on the wrong line.
 */
export function importReviews(
  ctx: ImportContext,
  pullId: string,
  headOid: string,
  diff: Diff | undefined,
  reviews: readonly RemoteReview[],
): number {
  let added = 0;
  const write = ctx.db.transaction(() => {
    for (const remote of reviews) {
      if (remote.remoteId === "" || remote.path === "") continue;
      const body = clamp(remote.body, MAX_BODY);
      const content =
        diff === undefined
          ? undefined
          : anchorContentIn(diff, remote.path, remote.side, remote.line);
      const lineHash = content === undefined ? "" : hashLine(content);
      const existing = ctx.db
        .query<
          { id: string },
          [string, string]
        >("SELECT id FROM comment WHERE issue_id = ?1 AND origin_remote_id = ?2")
        .get(pullId, remote.remoteId);
      if (existing) {
        ctx.db
          .query("UPDATE comment SET body = ?1 WHERE id = ?2")
          .run(body, existing.id);
        continue;
      }
      ctx.db
        .query(
          `INSERT INTO comment (id, issue_id, author_id, body, kind, path, line, side,
                              commit_oid, line_hash, outdated, created_at, updated_at,
                              origin_remote_id, origin_author)
         VALUES (?1, ?2, ?3, ?4, 'review', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13)`,
        )
        .run(
          id(),
          pullId,
          ctx.actorId,
          body,
          remote.path,
          remote.line,
          remote.side,
          headOid,
          lineHash,
          lineHash === "" ? 1 : 0,
          remote.createdAt,
          remote.remoteId,
          oneLine(remote.author, MAX_TITLE),
        );
      added++;
    }
  });
  write();
  return added;
}

/** The text at an anchor, or undefined when the diff has no such row. */
function anchorContentIn(
  diff: Diff,
  path: string,
  side: "old" | "new",
  line: number,
): string | undefined {
  const file = diff.files.find((f) => f.path === path);
  if (!file) return undefined;
  for (const hunk of file.hunks) {
    for (const row of hunk.lines) {
      const rowSide = row.kind === "del" ? "old" : "new";
      if (rowSide !== side) continue;
      const number = side === "old" ? row.oldNumber : row.newNumber;
      if (number === line) return row.content;
    }
  }
  return undefined;
}

/** One imported comment, by the origin's id — what a write-through reads
 * back after posting, so the row it returns is the origin's own copy. */
export function commentByRemoteId(
  db: Database,
  issueId: string,
  remoteId: string,
): string | undefined {
  return db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM comment WHERE issue_id = ?1 AND origin_remote_id = ?2")
    .get(issueId, remoteId)?.id;
}

/**
 * Set an issue's labels from names, creating any the repo does not have yet.
 * Used by write-through: the origin has already accepted the set, so this is
 * reflecting its answer rather than deciding anything.
 */
export function applyLabelNames(
  db: Database,
  repoId: string,
  issueId: string,
  names: readonly string[],
): void {
  const write = db.transaction(() => {
    const ids = names
      .map((name) => name.trim())
      .filter((name) => name !== "")
      .map((name) => labelIdFor(db, repoId, name));
    db.query("DELETE FROM issue_label WHERE issue_id = ?1").run(issueId);
    const link = db.query(
      "INSERT OR IGNORE INTO issue_label (issue_id, label_id) VALUES (?1, ?2)",
    );
    for (const labelId of ids) link.run(issueId, labelId);
  });
  write();
}

/**
 * Bring a pull's *verdicts* in line with the origin's.
 *
 * Keyed on the origin's review id, like every other import here, so a
 * re-sync of the same reviews rewrites the same rows. The local `author_id`
 * is the connecting user (the convention this whole module rests on) and
 * `origin_author` carries the reviewer's login — which is also the key
 * `latestReviewByAuthor` collapses on, so five upstream reviewers stay five
 * reviewers rather than becoming five verdicts by one person.
 *
 * Returns how many were new.
 */
export function importReviewStates(
  ctx: ImportContext,
  pullId: string,
  states: readonly RemoteReviewState[],
): number {
  let added = 0;
  const write = ctx.db.transaction(() => {
    for (const remote of states) {
      if (remote.remoteId === "") continue;
      const body = clamp(remote.body, MAX_BODY);
      const author = oneLine(remote.author, MAX_TITLE);
      const existing = ctx.db
        .query<
          { id: string },
          [string, string]
        >("SELECT id FROM review WHERE issue_id = ?1 AND origin_remote_id = ?2")
        .get(pullId, remote.remoteId);
      if (existing) {
        ctx.db
          .query(
            `UPDATE review SET state = ?1, body = ?2, commit_oid = ?3,
               origin_author = ?4 WHERE id = ?5`,
          )
          .run(remote.state, body, safeOid(remote.commitOid), author, existing.id);
        continue;
      }
      ctx.db
        .query(
          `INSERT INTO review (id, issue_id, author_id, state, body, commit_oid,
                               origin_remote_id, origin_author, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
        )
        .run(
          id(),
          pullId,
          ctx.actorId,
          remote.state,
          body,
          safeOid(remote.commitOid),
          remote.remoteId,
          author,
          remote.createdAt,
        );
      added++;
    }
  });
  write();
  return added;
}
