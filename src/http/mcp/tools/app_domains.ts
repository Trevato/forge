import {
  addAppDomain,
  checkAppDomain,
  listAppDomains,
  removeAppDomain,
} from "../../../actions/domains.ts";
import { type Answer, good, bad, type Tool, REPO_ARG, repoArg, isAnswer, str } from "../shared.ts";

export const tool: Tool = {
  name: "app_domains",
  doc: "`{ repo, action, host? }`: `list`, `add`, `check` (looks the DNS proof up now) or `remove` an app's own domains, with the records to publish, as `…/app/domains` answers; an admin of the repository with an admin-scope token",
  description: "App domains: list, add, check, remove.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string" },
      host: { type: "string" },
    },
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const action = args["action"];
    if (action !== "list" && action !== "add" && action !== "check" && action !== "remove")
      return bad("invalid", "action is list, add, check or remove");
    const host = str(args["host"]);
    if (action !== "list" && host === "") return bad("invalid", "host is the domain name");
    const answer = <T>(result: { ok: true; value: T } | { ok: false; error: string }): Answer =>
      result.ok
        ? good(result.value ?? {})
        : result.error === "not_found"
          ? bad("not_found", "no such app or repository (owner/name)")
          : bad(result.error, `the domain is refused: ${result.error}`);
    if (action === "list") {
      const listed = listAppDomains(ctx.app, user, repo);
      return listed.ok ? good({ items: listed.value, next_cursor: null }) : answer(listed);
    }
    if (action === "add") return answer(addAppDomain(ctx.app, user, repo, host));
    if (action === "check") return answer(await checkAppDomain(ctx.app, user, repo, host));
    return answer(removeAppDomain(ctx.app, user, repo, host));
  },
};
