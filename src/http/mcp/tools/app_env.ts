import { scopeAllows } from "../../../core/tokens.ts";
import { deleteAppEnvVar, listAppEnv, setAppEnvVar } from "../../../actions/apps.ts";
import { type Answer, good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "app_env",
  doc: "`{ repo, action, name?, value?, scope? }`: `list` an app's variable names and scopes, `set` one, or `unset` it, in `all` (default), `production` or `preview`; the API's rules and errors, an admin of the repository with an admin-scope token; a value is never read back",
  description:
    "An app's environment variables: list names, set or unset one by scope; values are write-only. Admin.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      action: { type: "string", enum: ["list", "set", "unset"] },
      name: { type: "string" },
      value: { type: "string" },
      scope: { type: "string", enum: ["all", "production", "preview"] },
    },
    required: ["repo", "action"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "an app's environment needs an admin-scope token");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const action = args["action"];
    const scope = typeof args["scope"] === "string" ? args["scope"] : "all";
    const name = typeof args["name"] === "string" ? args["name"] : "";
    // The API's errors, by code: never the value.
    const refused = (error: string): Answer =>
      error === "not_found"
        ? bad("not_found", "no such app or repository (owner/name)")
        : bad(error, error);
    if (action === "list") {
      const listed = listAppEnv(ctx.app, user, repo);
      return listed.ok ? good({ items: listed.value, next_cursor: null }) : refused(listed.error);
    }
    if (action === "set") {
      const value = typeof args["value"] === "string" ? args["value"] : "";
      const set = await setAppEnvVar(ctx.app, user, repo, name, value, scope);
      return set.ok ? good(set.value) : refused(set.error);
    }
    if (action === "unset") {
      const removed = await deleteAppEnvVar(ctx.app, user, repo, name, scope);
      return removed.ok ? good({}) : refused(removed.error);
    }
    return bad("invalid", "`action` is list, set or unset");
  },
};
