/**
 * Carry: a migrated repository's conversations, brought along once.
 *
 * A mirror keeps importing; a migration imports one time and then the
 * forge is where the conversation lives. So the rows are written by the
 * mirror's own upserts (`import.ts` — the same clamps, the origin's
 * numbers, `issue_seq` dragged past them, the real author in
 * `origin_author` so every page says "by @x on GitHub") with two
 * differences that make them native:
 *
 * - every issue and pull starts with a line naming where it came from and
 *   linking the original, so the trail back survives the origin; and
 * - a pull is a pull *here*: `origin_head_repo` is cleared, so it reviews,
 *   merges and reverts like one opened on this forge. Its head is the
 *   branch the clone already brought. A pull whose head lived in a fork
 *   keeps `origin_head_repo` — a stranger's code, whose check and preview
 *   wait for a writer's "Approve to run here" (`core/pull_trust.ts`), as a
 *   mirror's do — and is returned in `forkPulls`, for the caller to fetch
 *   its head into `refs/pull/<n>/head`.
 *
 * Milestones come too (`milestones.ts`), once each.
 *
 * Every issue comes, open and closed; of pulls only the open ones — a
 * closed pull's work is either in the history already or was turned down.
 * Plain data in (a provider, the repository's ids), counts out; no git.
 */

import type { Database } from "bun:sqlite";
import { carryMilestone } from "./milestones.ts";
import { importComments, importIssue, importLabels } from "./import.ts";
import type { ListIssuesQuery, Provider, RemoteIssue } from "./types.ts";

/** Pages of 100 per kind: 10 000 conversations is the ceiling of one move. */
export const MAX_PAGES = 100;

export interface CarryInput {
  readonly db: Database;
  readonly provider: Provider;
  /** `owner/name` on the origin. */
  readonly fullName: string;
  readonly repoId: string;
  /** Who migrated it: the local author of every row, as a mirror's are. */
  readonly actorId: string;
  /** Progress, as a job's detail line. */
  readonly report?: (stage: "issues" | "pulls", detail: string) => void;
}

export interface ForkPull {
  readonly issueId: string;
  readonly number: number;
}

export interface Carried {
  readonly labels: number;
  readonly issues: number;
  readonly pulls: number;
  readonly comments: number;
  /** Milestones made here: those already carried are not counted. */
  readonly milestones: number;
  /** Open pulls whose head branch is in a fork, not in the clone. */
  readonly forkPulls: readonly ForkPull[];
  /** The first thing the origin refused, in words; "" when nothing was. */
  readonly error: string;
}

/** What a person calls the origin: "GitHub", or its host. */
export function originName(provider: Pick<Provider, "kind" | "webUrl">): string {
  if (provider.kind === "github") return "GitHub";
  return URL.parse(provider.webUrl)?.host ?? "the origin";
}

/**
 * The line an imported body opens with. The link is only an http(s) URL
 * the origin gave — anything else is named without one — and the author's
 * login is reduced to the characters a login can hold.
 */
export function backlink(
  remote: Pick<RemoteIssue, "number" | "author" | "htmlUrl">,
  fullName: string,
  where: string,
): string {
  const url = URL.parse(remote.htmlUrl);
  const ref = `${fullName}#${remote.number}`;
  const linked =
    url !== null && (url.protocol === "https:" || url.protocol === "http:")
      ? `[${ref}](${url.href.replace(/[()\s]/g, encodeURIComponent)})`
      : ref;
  const login = remote.author.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 64);
  const by = login === "" ? "" : ` by @${login}`;
  return `> Migrated from ${linked}${by} on ${where}.`;
}

export async function carryConversations(input: CarryInput): Promise<Carried> {
  const { db, provider, fullName, repoId, actorId } = input;
  const where = originName(provider);
  const ctx = { db, repoId, actorId };
  let error = "";
  const counts = { labels: 0, issues: 0, pulls: 0, comments: 0, milestones: 0 };
  const forkPulls: ForkPull[] = [];

  const labels = await provider.listLabels(fullName);
  if (labels.ok) {
    importLabels(db, repoId, labels.value);
    counts.labels = labels.value.length;
  } else error = labels.error.message;

  const passes: [ListIssuesQuery["kind"], ListIssuesQuery["state"]][] = [
    ["issue", "all"],
    ["pull", "open"],
  ];
  for (const [kind, state] of passes) {
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await provider.listIssues(fullName, {
        kind,
        state,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!listed.ok) {
        error ||= listed.error.message;
        break;
      }
      for (const remote of listed.value.items) {
        if (!Number.isInteger(remote.number) || remote.number < 1) continue;
        // A listing of issues that slips a pull in (or the reverse) is not
        // trusted to say which it is twice.
        if ((remote.pull !== undefined) !== (kind === "pull")) continue;
        const body = `${backlink(remote, fullName, where)}\n\n${remote.body}`;
        const imported = importIssue(ctx, { ...remote, body });
        if (remote.pull !== undefined) {
          const sameRepo =
            remote.pull.headRepo === "" ||
            remote.pull.headRepo.toLowerCase() === fullName.toLowerCase();
          if (sameRepo)
            db.query(
              "UPDATE pull SET origin_head_repo = NULL WHERE issue_id = ?1",
            ).run(imported.issueId);
          else forkPulls.push({ issueId: imported.issueId, number: remote.number });
          counts.pulls++;
        } else counts.issues++;

        if (remote.comments > 0) {
          const comments = await provider.listComments(fullName, remote.number);
          if (comments.ok)
            counts.comments += importComments(ctx, imported.issueId, comments.value);
          else error ||= comments.error.message;
        }
        input.report?.(
          kind === "issue" ? "issues" : "pulls",
          kind === "issue"
            ? `${plural(counts.issues, "issue")}, ${plural(counts.comments, "comment")}`
            : plural(counts.pulls, "open pull request"),
        );
      }
      if (listed.value.next === null) break;
      cursor = listed.value.next;
    }
  }

  // After the issues, so a milestone's number here is past every number the
  // origin gave a conversation.
  if (provider.listMilestones !== undefined) {
    const listed = await provider.listMilestones(fullName);
    if (listed.ok) {
      for (const remote of listed.value)
        if (carryMilestone(db, repoId, actorId, remote)?.created)
          counts.milestones++;
    } else error ||= listed.error.message;
  }
  return { ...counts, forkPulls, error };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
