import { mayView, sealedScope } from "../../../core/sealed.ts";
import { blockerIdsFor } from "../../../core/dependencies.ts";
import { pillarsOf, servedBy } from "../../../core/pillars.ts";
import { getIssuesByIds, labelsForIssues, type Issue, listIssues, LIST_LIMIT, LIST_LIMIT_MAX } from "../../../core/issues.ts";
import { isCrew } from "../../../core/agents.ts";
import { canRead, canWrite, getRepoById, type Repo } from "../../../core/repos.ts";
import { markReaders } from "../../../crew/direct.ts";
import type { Database } from "bun:sqlite";
import type { User } from "../../../core/users.ts";
import { ISSUES_ROWS } from "../../../web/studio/cards.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "issues",
  doc: "`{ repo, state?, label?, author?, limit?, cursor? }`: a repository's issues, newest first, as `{ items, next_cursor }` like `GET …/issues?fields=brief`: `number`, `title`, `state`, `labels`, `assignee`, `author`, `authorIsAgent`, `createdAt`, `updatedAt`, and `untrusted: true` on text from someone who cannot write; `state` open (default), closed or all, `label` a name, `author` a username, `limit` 1-200 (default 50), `cursor` the last `next_cursor`; a sealed issue you cannot see is left out, a repository you cannot read is not found; draws the `ui://forge/issues` card: state, pillar and what each waits on",
  description: "A repository's issues by state, label and author, newest first, paged.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      state: { type: "string", enum: ["open", "closed", "all"] },
      label: { type: "string" },
      author: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
      cursor: { type: "string" },
    },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const state = args["state"] ?? "open";
    if (state !== "open" && state !== "closed" && state !== "all")
      return bad("invalid", "`state` is open, closed or all");
    const limit = args["limit"] ?? LIST_LIMIT;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX)
      return bad("invalid_limit", `limit is a whole number from 1 to ${LIST_LIMIT_MAX}`);
    let cursor: number | undefined;
    if (args["cursor"] !== undefined) {
      const raw = args["cursor"];
      cursor = typeof raw === "string" && /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
      if (cursor === undefined || cursor < 1)
        return bad("invalid_cursor", "cursor is the next_cursor of a page before");
    }
    const text = (key: string): string | undefined | Error => {
      const v = args[key];
      if (v === undefined) return undefined;
      return typeof v === "string" && v.length <= 200 ? v || undefined : new Error(key);
    };
    const label = text("label");
    const author = text("author");
    if (label instanceof Error || author instanceof Error)
      return bad("invalid", "`label` and `author` are names");
    const db = ctx.app.db;
    const rows = listIssues(db, repo.id, {
      state,
      limit,
      kind: "issue",
      ...(cursor === undefined ? {} : { cursor }),
      ...(label === undefined ? {} : { label }),
      ...(author === undefined ? {} : { author }),
      ...sealedScope(db, repo, user),
    });
    // Marked as `issue` marks: only for a crew agent, or the forge's own agent
    // speaking for a writer.
    const marking =
      (user.kind === "agent" && isCrew(db, repo.id, user.id)) ||
      (ctx.auth.through !== undefined && canWrite(db, repo, user));
    const marked = new Map<string, string | undefined>();
    if (marking) for (const m of markReaders(db, repo, rows)) marked.set(m.id, m.untrusted);
    const labels = labelsForIssues(db, rows.map((i) => i.id));
    const last = rows[rows.length - 1];
    const card = ctx.auth.through === undefined ? cardExtras(db, repo, user, rows) : undefined;
    const answer = good({
      items: rows.map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        labels: labels.get(i.id) ?? [],
        assignee: i.assigneeName,
        author: i.originAuthor ?? i.authorName,
        authorIsAgent: i.authorIsAgent,
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        ...(marked.get(i.id) === undefined ? {} : { untrusted: true }),
      })),
      next_cursor: rows.length >= limit && last !== undefined ? String(last.number) : null,
    });
    return card === undefined ? answer : { ...answer, card };
  },
};

/**
 * The card's extras, by issue number: the pillar each issue serves and what it waits on. Blockers
 * are read by id in one query, so one in another repository is named with its repo, and one you
 * cannot see (sealed, or in a repository you cannot read) is left out.
 */
function cardExtras(
  db: Database,
  repo: Repo,
  user: User,
  rows: readonly Issue[],
): Record<string, unknown> {
  const shown = rows.slice(0, ISSUES_ROWS);
  const served = servedBy(db, pillarsOf(db, repo));
  const blockerIds = blockerIdsFor(db, shown.map((i) => i.id));
  const blockers = getIssuesByIds(db, [...blockerIds.values()].flat());
  const repos = new Map<string, Repo | undefined>([[repo.id, repo]]);
  const repoOf = (id: string): Repo | undefined => {
    if (!repos.has(id)) repos.set(id, getRepoById(db, id));
    return repos.get(id);
  };
  const pillars: Record<string, string> = {};
  const waits: Record<string, string[]> = {};
  for (const i of shown) {
    const p = served.get(i.id);
    if (p !== undefined) pillars[String(i.number)] = p;
    const on: string[] = [];
    for (const id of blockerIds.get(i.id) ?? []) {
      const b = blockers.get(id);
      const home = b === undefined ? undefined : repoOf(b.repoId);
      if (b === undefined || home === undefined) continue;
      if (home.id !== repo.id && !canRead(db, home, user)) continue;
      if (!mayView(db, home, b, user)) continue;
      on.push(home.id === repo.id ? String(b.number) : `${home.ownerName}/${home.name}#${b.number}`);
    }
    if (on.length > 0) waits[String(i.number)] = on;
  }
  return { repo: `${repo.ownerName}/${repo.name}`, pillars, waits };
}
