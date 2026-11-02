import { listProposals, mintProposal, repoByName, revokeProposal } from "../../../actions/proposal_tokens.ts";
import { good, bad, type Tool, REPO_ARG } from "../shared.ts";

export const tool: Tool = {
  name: "proposal_tokens",
  doc: "`{ repo, verb, child?, origin?, childRepo?, id? }`: give a child forge a propose-only credential: `mint` one (`child`, `origin`), `list` them, or `revoke` one by `id`; writers only",
  description:
    "A child's propose-only token: `mint` (`child`, `origin`), `list`, `revoke` (`id`). Writers.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      verb: { type: "string", enum: ["mint", "list", "revoke"] },
      child: { type: "string", maxLength: 40 },
      origin: { type: "string", maxLength: 200 },
      childRepo: { type: "string", maxLength: 200 },
      id: { type: "string", maxLength: 80 },
    },
    required: ["repo", "verb"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoByName(ctx.app, args["repo"]);
    const verb = args["verb"];
    const done =
      verb === "mint"
        ? mintProposal(ctx.app, user, repo, {
            child: args["child"],
            origin: args["origin"],
            childRepo: args["childRepo"],
          })
        : verb === "list"
          ? listProposals(ctx.app, user, repo)
          : verb === "revoke"
            ? revokeProposal(ctx.app, user, repo, args["id"])
            : undefined;
    if (done === undefined) return bad("invalid", "verb is mint, list or revoke");
    return done.ok ? good(done.value ?? { ok: true }) : bad(done.error.code, done.error.message);
  },
};
