import { accountSignIns, endAccountSession } from "../../../actions/signins.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "sessions",
  doc: "`{ username?, action?, id? }`: where you (or, as the forge's owner, a person) are signed in: tokens and browsers, as `GET /api/v1/users/:username/signins` lists them, never a secret; `action: \"end\"` with a session `id` signs that browser out, as `DELETE /api/v1/users/:username/sessions/:id` does, and says so when it was this one; an admin-scope token, the route's refusals",
  description: "Where you are signed in: your tokens and browsers, never a secret; `username` for a person as owner; action end + id signs a browser out.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string", maxLength: 64 },
      action: { type: "string", enum: ["list", "end"] },
      id: { type: "string", maxLength: 64 },
    },
  },
  writes: true,
  readsWhen: (args) => (args["action"] ?? "list") === "list",
  needsAdminScope: true,
  run(ctx, user, args) {
    const name = typeof args["username"] === "string" && args["username"] !== "" ? args["username"] : user.username;
    const action = args["action"] ?? "list";
    if (action !== "list" && action !== "end") return bad("bad_action", "action is list or end");
    if (action === "end") {
      const id = args["id"];
      if (typeof id !== "string" || id === "") return bad("bad_id", "id is a session id from the list");
      const done = endAccountSession(ctx.app, user, name, id);
      if (!done.ok) return bad("not_found", "no such session");
      return good({
        ended: id,
        says: name === user.username
          ? "Signed that browser out of your account; if it is the one you are in now, it is signed out."
          : `Signed that browser out of ${name}.`,
      });
    }
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
