import { FAMILY_WORDS } from "../../../actions/family_words.ts";
import { convergeWords, takeForgeCode, takeForgeWords, takeOrTell } from "../../../actions/follow.ts";
import { chainOfRepo } from "../../../spawn/chain.ts";
import { forkParentFor } from "../../../core/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "take_updates",
  doc: "`{ repo }`: a fork takes its parent's updates when git can do it alone; a conflict is refused. On a spawned forge's code repository it opens the one `forge/take-updates` pull and never moves the default branch",
  description:
    "Take the parent forge's updates into a fork.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    // No parent in this forge but a chain across forges: the parent's code comes as a pull.
    if (forkParentFor(ctx.app.db, repo, user) === undefined && (await chainOfRepo(ctx.app, repo)) !== undefined) {
      const across = await takeForgeCode(ctx.app, user, repo);
      if (across.ok) return good({ ...across.value, ...takeForgeWords(across.value) });
      return across.error === "not_following"
        ? bad("not_following", FAMILY_WORDS.not_following)
        : bad(across.error, "only this repository's admin can take the parent forge's code");
    }
    const took = await takeOrTell(ctx.app, user, repo);
    if (took.ok)
      return good({
        says: !took.value.updated
          ? "Already up to date."
          : took.value.merged
            ? `Merged the parent's updates at ${took.value.to.slice(0, 7)}.`
            : `Updated to ${took.value.to.slice(0, 7)}.`,
        ...took.value,
      });
    const e = took.error;
    const up = forkParentFor(ctx.app.db, repo, user);
    const parentName = up === undefined ? "the parent" : `${up.ownerName}/${up.name}`;
    if (typeof e === "string")
      return bad(
        e,
        e === "not_a_fork"
          ? "this repository follows nothing"
          : "you need write access to take updates here",
      );
    return e.kind === "conflict"
      ? bad(
          "conflict",
          `both sides changed ${e.files.join(", ")}. ${"converge" in e ? convergeWords(e.converge, parentName).message : ""}`,
        )
      : bad(
          e.kind,
          e.kind === "moved" ? "something moved; try again" : e.message,
        );
  },
};
