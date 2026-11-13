import { provenanceFacts } from "../../../core/provenance.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { audienceFor } from "../../../core/audience.ts";
import { upstreamFacts } from "../../../actions/upstream_follow.ts";
import { creditFacts } from "../../../actions/credit_facts.ts";
import { getChapter, itemsOf, listChapters, progressOf, progressSentence } from "../../../core/chapters.ts";
import { good, str, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "repo",
  doc: "`{ repo }`: one repository's description, visibility, autonomy, `audience { level, who, sentence }` and `provenance` (where a migrated one came from, `null` when hidden), `credit` (a mirror's upstream, licence, authors; `null` otherwise), the same as `GET /api/v1/repos/:owner/:name`; `view: \"chapters\"` lists its chapters with state, and with `chapter` names one's items (`done|building|left`) and `progress` (the page's sentence)",
  description:
    "One repository you can read, as GET /api/v1/repos/:owner/:name.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, view: { type: "string", enum: ["chapters"] }, chapter: { type: "string" } },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["view"] === undefined && args["chapter"] !== undefined) return bad("invalid", "`chapter` needs `view: chapters`");
    if (args["view"] !== undefined) {
      if (args["view"] !== "chapters") return bad("invalid", "`view` is \"chapters\"");
      const now = new Date();
      const name = str(args["chapter"]);
      if (name === "")
        return good({ chapters: listChapters(ctx.app.db, repo.id).map((c) => ({ name: c.name, means: c.means, state: c.state })) });
      const c = getChapter(ctx.app.db, repo.id, name);
      if (c === undefined) return bad("not_found", "no such chapter");
      const items = itemsOf(ctx.app.db, c);
      const p = progressOf(c, items, now);
      return good({
        name: c.name, means: c.means, state: c.state, progress: progressSentence(p), finishesOn: p.finishesOn,
        items: items.map((i) => ({ number: i.number, title: i.title, status: i.status, doneAt: i.doneAt })),
      });
    }
    return good({
      repo: `${repo.ownerName}/${repo.name}`,
      description: repo.description,
      visibility: repo.visibility,
      autonomy: repo.autonomy,
      audience: audienceFor(ctx.app.db, repo, user),
      provenance: provenanceFacts(
        ctx.app.db,
        repo,
        forkParentFor(ctx.app.db, repo, user),
      ),
      upstream: upstreamFacts(ctx.app.db, repo, user),
      credit: await creditFacts(ctx.app, repo, user),
    });
  },
};
