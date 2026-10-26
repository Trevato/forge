import { verifyAccount } from "../../../actions/accounts.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "account_verify",
  doc: "`{ username }`: mark a person's email verified, as `POST …/admin/accounts/:username/verify` does; a person admin's, with an admin token",
  description: "Mark a person's email verified (admin).",
  inputSchema: {
    type: "object",
    properties: { username: { type: "string" } },
    required: ["username"],
  },
  writes: true,
  run(ctx, user, args) {
    const { username } = args;
    if (typeof username !== "string") return bad("invalid", "send a username");
    if (!mayBoards(user)) return bad("forbidden", "verifying a person is a forge admin's call");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "verifying a person needs an admin token");
    const done = verifyAccount(ctx.app, user, username);
    if (done.ok) return good({ username: done.value.username, verified: true });
    return done.error === "not_found"
      ? bad("not_found", "no such account")
      : bad("invalid", "an agent or a removed account has no email to verify");
  },
};
