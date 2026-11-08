import { scopeAllows } from "../../../core/tokens.ts";
import { emailVerified } from "../../../core/verify.ts";
import { updateProfile } from "../../../actions/users.ts";
import { publicUser } from "../../respond.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "profile",
  doc: "`{ displayName?, email?, commitEmail? }`: your own profile (`publicUser` and `emailVerified`, never the address); with an argument it changes it by the rules of `PATCH /api/v1/user`, and needs admin scope: only a site admin can mint such a token, so most people sign in to `/mcp` with their password",
  description: "Read or change your profile.",
  inputSchema: {
    type: "object",
    properties: {
      displayName: { type: "string" },
      email: { type: "string" },
      commitEmail: { type: "string" },
    },
  },
  writes: true,
  readsWithout: ["displayName", "email", "commitEmail"],
  run(ctx, user, args) {
    const { displayName, email, commitEmail } = args;
    if (displayName === undefined && email === undefined && commitEmail === undefined)
      return good({ ...publicUser(user), emailVerified: emailVerified(ctx.app.db, user.id) });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing your profile needs an admin-scope token");
    if (commitEmail !== undefined && commitEmail !== "noreply" && commitEmail !== "account")
      return bad("invalid_commit_email", "invalid_commit_email");
    const updated = updateProfile(ctx.app, user, {
      ...(typeof displayName === "string" ? { displayName } : {}),
      ...(typeof email === "string" ? { email } : {}),
      ...(commitEmail === "noreply" || commitEmail === "account" ? { commitEmail } : {}),
    });
    return updated.ok ? good(publicUser(updated.value)) : bad(updated.error, updated.error);
  },
};
