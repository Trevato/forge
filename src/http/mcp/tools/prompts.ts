import { addPromptSource, listPromptSources, removePromptSource, runPromptSource } from "../../../actions/prompts.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "prompts",
  doc: "`{ repo, action, kind?, token?, at?, id? }`: list, add, run or remove an app's prompt sources (Instagram), as the `…/prompts` API does; the token goes in once and is never shown; listed only for an admin-scope token, and only the repository's admin may use it",
  description:
    "Prompt sources: list, add (`kind`, `token`, `at`), run or remove (`id`). Admin.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string", enum: ["list", "add", "run", "remove"] },
      kind: { type: "string", enum: ["instagram"] },
      token: { type: "string", description: "add: sealed, never shown again" },
      at: { type: "string", description: "HH:MM UTC" },
      id: { type: "string" },
    },
    required: ["repo", "action"],
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const refuse = (error: string) =>
      error === "not_found"
        ? bad("not_found", "no such app or repository (owner/name)")
        : bad(error, error.replaceAll("_", " "));
    const action = args["action"];
    if (action === "list") {
      const listed = listPromptSources(ctx.app, user, repo);
      return listed.ok ? good({ items: listed.value }) : refuse(listed.error);
    }
    if (action === "add") {
      const added = addPromptSource(ctx.app, user, repo, {
        kind: str(args["kind"]),
        token: str(args["token"]),
        at: str(args["at"]),
      });
      return added.ok ? good(added.value) : refuse(added.error);
    }
    const id = str(args["id"]);
    if (action === "run") {
      const ran = await runPromptSource(ctx.app, user, repo, id);
      return ran.ok ? good(ran.value) : refuse(ran.error);
    }
    if (action === "remove") {
      const removed = removePromptSource(ctx.app, user, repo, id);
      return removed.ok ? good({ removed: true }) : refuse(removed.error);
    }
    return bad("bad_action", "`action` is list, add, run or remove");
  },
};
