import { mayView } from "../../../core/sealed.ts";
import { getIssue, labelsFor, listComments } from "../../../core/issues.ts";
import { isCrew } from "../../../core/agents.ts";
import { dependenciesOf } from "../../../core/dependencies.ts";
import { getUsersByIds } from "../../../core/users.ts";
import { markReaders } from "../../../crew/direct.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "issue",
  doc: "`{ repo, number }`: one issue's title, state, closeReason, body, labels, assignee, comments (author, authorIsAgent, body, at) and blockedBy/blocks, as `GET …/issues/:number`; a sealed one you cannot see is not found; draws the `ui://forge/issue` card: title, state, assignee, labels and what it waits for, never the body or comments",
  description:
    "One issue with comments, `blockedBy`, `blocks`; non-writers' text is `untrusted`.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
    },
    required: ["repo", "number"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    const issue =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getIssue(ctx.app.db, repo.id, n)
        : undefined;
    if (issue === undefined || !mayView(ctx.app.db, repo, issue, user))
      return bad("not_found", `no issue #${String(n)}`);
    // Seen only after the sealed check, so a sealed pull is not told apart.
    if (issue.kind !== "issue") return good({ kind: "pull", tool: "pull" });
    const db = ctx.app.db;
    // Marked only for a crew agent, as the API does: to anyone else the
    // mark would say which commenters cannot write.
    const marking = user.kind === "agent" && isCrew(db, repo.id, user.id);
    const mark = <T extends { authorName: string; originAuthor: string | null }>(
      items: readonly T[],
    ): (T & { untrusted?: string })[] =>
      marking ? markReaders(db, repo, items) : [...items];
    const comments = mark(listComments(db, issue.id));
    const authors = getUsersByIds(db, [...new Set(comments.map((c) => c.authorId))]);
    const deps = dependenciesOf(db, issue.id);
    const brief = (i: typeof issue) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      ...(i.closeReason === null ? {} : { closeReason: i.closeReason }),
    });
    const seen = (i: typeof issue) => mayView(db, repo, i, user);
    const flag = (x: { untrusted?: string }) =>
      x.untrusted === undefined ? {} : { untrusted: true };
    const [self] = mark([issue]);
    const answer = good({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      closeReason: issue.closeReason,
      body: issue.body,
      author: issue.authorName,
      authorIsAgent: issue.authorIsAgent,
      ...flag(self!),
      labels: labelsFor(db, issue.id).map((l) => l.name),
      assignee: issue.assigneeName,
      comments: comments.map((c) => ({
        author: c.authorName,
        authorIsAgent: authors.get(c.authorId)?.kind === "agent",
        body: c.body,
        at: c.createdAt,
        ...flag(c),
      })),
      blockedBy: deps.blockedBy.filter(seen).map(brief),
      blocks: deps.blocks.filter(seen).map(brief),
    });
    // Where the issue lives, for the card's links.
    return { ...answer, card: { repo: `${repo.ownerName}/${repo.name}` } };
  },
};
