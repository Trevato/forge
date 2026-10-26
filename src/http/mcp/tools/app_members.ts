import { scopeAllows } from "../../../core/tokens.ts";
import { readAppMembers, setAppMembersThrough } from "../../../actions/app_members.ts";
import { SETTING_WORDS } from "../../../actions/setting_words.ts";
import { type Answer, good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "app_members",
  doc: "`{ repo, members?, dryRun? }`: the people a private app names, who may enter it and its previews and nothing else; a writer (never an agent) changes the list with an admin-scope token",
  description:
    "People a private app names, who may enter it and its previews. With `members`, plans.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      members: { type: "array", items: { type: "string" } },
      dryRun: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const members = args["members"];
    const answer = (
      result: ReturnType<typeof readAppMembers> | ReturnType<typeof setAppMembersThrough>,
    ): Answer =>
      result.ok
        ? good(result.value)
        : result.error.kind === "invalid"
          ? bad("invalid", result.error.message)
          : result.error.kind === "forbidden"
            ? bad("forbidden", SETTING_WORDS.appMembersForbidden)
            : bad("not_found", "no such app or repository (owner/name)");
    if (members === undefined) return answer(readAppMembers(ctx.app, user, repo));
    if (!Array.isArray(members) || !members.every((m) => typeof m === "string"))
      return bad("invalid", "members is a list of usernames");
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing who may enter an app needs an admin-scope token");
    return answer(setAppMembersThrough(ctx.app, user, repo, { members, dryRun }));
  },
};
