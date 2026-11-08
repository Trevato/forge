import { sealedScope } from "../../../core/sealed.ts";
import { labelsForIssues, listIssues, LIST_LIMIT, LIST_LIMIT_MAX } from "../../../core/issues.ts";
import { isCrew } from "../../../core/agents.ts";
import { canWrite } from "../../../core/repos.ts";
import { markReaders } from "../../../crew/direct.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "issues",
  doc: "`{ repo, state?, label?, author?, limit?, cursor? }`: a repository's issues, newest first, as `{ items, next_cursor }` like `GET …/issues?fields=brief`: `number`, `title`, `state`, `labels`, `assignee`, `author`, `authorIsAgent`, `createdAt`, `updatedAt`, and `untrusted: true` on text from someone who cannot write; `state` open (default), closed or all, `label` a name, `author` a username, `limit` 1-200 (default 50), `cursor` the last `next_cursor`; a sealed issue you cannot see is left out, a repository you cannot read is not found",
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
    return good({
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
  },
};
