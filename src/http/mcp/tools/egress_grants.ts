import { scopeAllows } from "../../../core/tokens.ts";
import { egressView, grantAppEgress, revokeAppEgress } from "../../../actions/egress_grants.ts";
import { FORBIDDEN_MESSAGE } from "../../respond.ts";
import { type Answer, good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "egress_grants",
  doc: "`{ repo, op?, destination? }`: the private `host:port` destinations an app's forge.json asks for and which are granted; `op` grant or revoke by a site admin (never an agent), and every op needs an admin-scope token; the same as the settings page and `/api/v1/repos/:owner/:name/egress-grants`",
  description:
    "An app's private destinations and their grants: list, grant or revoke (site admin). See docs/MCP.md.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      op: { type: "string", enum: ["list", "grant", "revoke"] },
      destination: { type: "string" },
    },
    required: ["repo"],
  },
  writes: true,
  readsWithout: "op",
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const op = args["op"] === undefined ? "list" : str(args["op"]);
    if (op !== "list" && op !== "grant" && op !== "revoke")
      return bad("invalid", "op is list, grant or revoke");
    // The API's rule: reading or changing grants takes an admin-scope token.
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "egress grants need an admin-scope token");
    const refused = (error: string): Answer => {
      if (error === "not_found")
        return bad("not_found", "no such app or repository (owner/name)");
      if (error === "forbidden") return bad("forbidden", FORBIDDEN_MESSAGE);
      return bad(error, error);
    };
    if (op === "list") {
      const view = await egressView(ctx.app, user, repo);
      return view.ok
        ? good({ items: view.value.rows, changes: view.value.changes })
        : refused(view.error);
    }
    const destination = str(args["destination"]);
    if (op === "grant") {
      const granted = await grantAppEgress(ctx.app, user, repo, destination);
      return granted.ok ? good(granted.value) : refused(granted.error);
    }
    const revoked = revokeAppEgress(ctx.app, user, repo, destination);
    return revoked.ok ? good({ revoked: revoked.value }) : refused(revoked.error);
  },
};
