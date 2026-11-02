import { suspendAccount, unsuspendAccount } from "../../../actions/accounts.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { lastOwnerSays } from "../../../core/orgs.ts";
import { ADMIN_WORDS } from "../../../actions/admin_words.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "account_suspend",
  doc: "`{ username, suspended }`: suspend a person's account, or unsuspend it with `false`; their sessions and tokens stop at once; the API's rules (not yourself, another admin or an agent; not the only owner of an organization); an admin token",
  description: "Suspend an account; `suspended: false` lifts.",
  inputSchema: {
    type: "object",
    properties: { username: { type: "string" }, suspended: { type: "boolean" } },
    required: ["username", "suspended"],
  },
  writes: true,
  async run(ctx, user, args) {
    const { username, suspended } = args;
    if (typeof username !== "string" || typeof suspended !== "boolean")
      return bad("invalid", "send a username and suspended, true or false");
    if (!mayBoards(user)) return bad("forbidden", "an account is a forge admin's to suspend");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "suspending needs an admin token");
    const done = suspended
      ? await suspendAccount(ctx.app, user, username)
      : unsuspendAccount(ctx.app, user, username);
    if (done.ok) return good({ username: done.value.username, suspendedAt: done.value.suspendedAt });
    if (done.error === "not_found") return bad("not_found", "no such person");
    if (done.error === "last_owner") return bad("last_owner", lastOwnerSays(ctx.app.db, username));
    return bad("not_allowed", ADMIN_WORDS.selfSuspend);
  },
};
