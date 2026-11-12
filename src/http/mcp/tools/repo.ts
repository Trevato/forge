import { provenanceFacts } from "../../../core/provenance.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { audienceFor } from "../../../core/audience.ts";
import { upstreamFacts } from "../../../actions/upstream_follow.ts";
import { creditFacts } from "../../../actions/credit_facts.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "repo",
  doc: "`{ repo }`: one repository's description, visibility, autonomy, `audience { level, who, sentence }` and `provenance` (where a migrated one came from, `null` when hidden), `credit` (a mirror's upstream, licence, authors; `null` otherwise), the same as `GET /api/v1/repos/:owner/:name`",
  description:
    "One repository you can read, as GET /api/v1/repos/:owner/:name.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
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
