import { revertPull } from "../../../actions/revert.ts";
import { takeBackWords } from "../../../actions/revert_words.ts";
import { getPull } from "../../../core/pulls.ts";
import { mayView } from "../../../core/sealed.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "take_back",
  doc: "`{ repo, number }`: open the pull that undoes shipped pull `number` (branch `revert-N`, title `Revert \"…\"`), never touching the default branch; the same rules and words as the pull page's take it back: refused for a pull not shipped (`not_shipped`), already taken back (`already_reverted`), on a mirror (`mirrored`), a revert that does not apply (`conflict`), an agent (`forbidden`) and a pull the caller cannot see (`not_found`); answers the new pull's `number`, `title` and `url`",
  description: "Open the pull that undoes a shipped pull.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
    },
    required: ["repo", "number"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    // `getPull` reads pulls only; an issue's number is not found, as on the page.
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
      return bad("not_found", `That could not be taken back: ${takeBackWords("not_found")}.`);
    const reverted = await revertPull(ctx.app, user, repo, pull);
    if (!reverted.ok) {
      const e = reverted.error;
      return bad(
        typeof e === "string" ? e : e.kind,
        `That could not be taken back: ${takeBackWords(e)}.`,
      );
    }
    const made = reverted.value;
    const origin = ctx.app.config.url ?? ctx.url.origin;
    return good({
      says: `Opened "${made.title}" — ship it to take "${pull.title}" back.`,
      number: made.number,
      title: made.title,
      url: `${origin}/${repo.ownerName}/${repo.name}/pulls/${made.number}`,
    });
  },
};
