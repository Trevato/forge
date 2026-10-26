import { list as listInviteLinks, revoke as revokeInviteLink } from "../../../actions/invites.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "invites",
  doc: "`{ action, id? }`: `list` the outstanding invites (state and expiry, never a link) or `revoke` one by `id`; a person admin with an admin token, stricter than the API's list, which an `ro` token may read",
  description: "List open invites, or revoke one by `id`.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "revoke"] },
      id: { type: "string" },
    },
    required: ["action"],
  },
  writes: true,
  run(ctx, user, args) {
    if (!mayBoards(user)) return bad("forbidden", "invites are a forge admin's");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "invites need an admin token");
    const action = args["action"];
    if (action === "list") {
      const listed = listInviteLinks(ctx.app, user);
      return listed.ok ? good({ items: listed.value }) : bad("forbidden", "invites are a forge admin's");
    }
    if (action === "revoke") {
      const id = args["id"];
      if (typeof id !== "string" || id === "") return bad("invalid", "revoke needs an invite id");
      const done = revokeInviteLink(ctx.app, user, id);
      return done.ok ? good(done.value) : bad("not_found", "no such open invite");
    }
    return bad("invalid", 'action is "list" or "revoke"');
  },
};
