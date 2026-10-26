import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { proposeToParentForge } from "../../../actions/upstream.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "propose_to_parent_forge",
  doc: "`{ repo }`: offer this forge's landed change to its parent as a pull on `child/<name>/…`; the same tip answers with that pull",
  description:
    "Offer this forge's landed change to its parent as a pull on `child/<name>/…`",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const made = await proposeToParentForge(ctx.app, user, repo);
    if (made.ok)
      return good({
        says: made.value.opened
          ? `Proposed to the parent forge as #${made.value.number}.`
          : `Already proposed to the parent forge as #${made.value.number}.`,
        opened: made.value.opened,
        proposal: made.value,
      });
    const e = made.error;
    if (e === "no_parent_forge") return bad(e, "this forge has no parent forge to propose to");
    if (e === "nothing_to_propose") return bad(e, FAMILY_WORDS.nothing_to_propose);
    if (typeof e === "string") return bad(e, "you need write access to propose from here");
    return e.kind === "unreachable"
      ? bad("parent_unreachable", "parent unreachable: nothing was proposed")
      : bad("refused", `the parent forge did not take the proposal: ${e.reason}`);
  },
};
