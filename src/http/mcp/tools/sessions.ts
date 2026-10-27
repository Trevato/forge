import { accountSignIns } from "../../../actions/signins.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "sessions",
  doc: "`{ username? }`: where you (or, as the forge's owner, a person) are signed in: tokens and browsers, as `GET /api/v1/users/:username/signins` lists them, never a secret; an admin-scope token, the route's refusals",
  description: "Where you are signed in: your tokens and browsers, never a secret; `username` for a person as owner.",
  inputSchema: {
    type: "object",
    properties: { username: { type: "string", maxLength: 64 } },
  },
  writes: false,
  needsAdminScope: true,
  run(ctx, user, args) {
    const name = typeof args["username"] === "string" && args["username"] !== "" ? args["username"] : user.username;
    const seen = accountSignIns(ctx.app, user, name);
    if (!seen.ok) return bad("not_found", "no such account");
    const { tokens, sessions } = seen.value;
    return good({
      tokens,
      sessions,
      says: `${seen.value.user.username} is signed in with ${sessions.length} browser${sessions.length === 1 ? "" : "s"} and ${tokens.length} token${tokens.length === 1 ? "" : "s"}.`,
    });
  },
};
