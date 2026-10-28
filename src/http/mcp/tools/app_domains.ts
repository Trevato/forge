import {
  addAppDomain,
  checkAppDomain,
  listAppDomains,
  removeAppDomain,
} from "../../../actions/domains.ts";
import {
  NO_SUCH_DOMAIN,
  domainAddedText,
  domainRefusalText,
  domainRemovedText,
  domainSaidText,
} from "../../../actions/domain_words.ts";
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
    const refused = (error: string, fallback: string): Answer =>
      error === "not_found"
        ? bad("not_found", "no such app or repository (owner/name)")
        : bad(error, domainRefusalText(error, fallback));
    if (action === "list") {
      const listed = listAppDomains(ctx.app, user, repo);
      return listed.ok
        ? good({ items: listed.value, next_cursor: null })
        : refused(listed.error, NO_SUCH_DOMAIN);
    }
    if (action === "add") {
      const added = addAppDomain(ctx.app, user, repo, host);
      return added.ok
        ? good({ ...added.value, says: domainAddedText(added.value) })
        : refused(added.error, "That domain could not be added.");
    }
    if (action === "check") {
      const checked = await checkAppDomain(ctx.app, user, repo, host);
      return checked.ok
        ? good({ ...checked.value, says: domainSaidText(checked.value) })
        : refused(checked.error, NO_SUCH_DOMAIN);
    }
    const removed = removeAppDomain(ctx.app, user, repo, host);
    return removed.ok
      ? good({ says: domainRemovedText(host) })
      : refused(removed.error, NO_SUCH_DOMAIN);
  },
};
