import { actOnProposal, isProposalVerb, PROPOSAL_VERBS } from "../../../actions/proposals.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "asks_proposal",
  description:
    "Act on a wave proposal (`asks` row): `approve`, `redirect` (`words`), `later` (`again`). Owner.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", maxLength: 80 },
      verb: { type: "string", enum: [...PROPOSAL_VERBS] },
      words: { type: "string", maxLength: 65536 },
    },
    required: ["id", "verb"],
  },
  writes: true,
  run(ctx, user, args) {
    const verb = args["verb"];
    if (!isProposalVerb(verb)) return bad("invalid", `verb is ${PROPOSAL_VERBS.join(", ")}`);
    const done = actOnProposal(ctx.app, user, verb, args["id"], args["words"]);
    return done.ok ? good(done.value ?? { ok: true }) : bad(done.error.code, done.error.message);
  },
};
