import { ACCESS_WORDS, accessUrl, endAllSessions, resetAccess } from "../../../actions/account_access.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "account_access",
  doc: "`{ username, action, endSessions?, dryRun? }`: `reset` makes a one-hour, one-use link for a person to set a new password and add a passkey (`endSessions` also signs them out; mailed when the forge can); `end_sessions` signs them out alone; planned first (`dryRun` is true unless `false`); an admin token",
  description: "Reset a person's access with a one-time link, or end their sessions.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      action: { type: "string", enum: ["reset", "end_sessions"] },
      endSessions: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
    required: ["username", "action"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const { username, action, endSessions } = args;
    if (typeof username !== "string" || (action !== "reset" && action !== "end_sessions"))
      return bad("invalid", 'send a username and an action, "reset" or "end_sessions"');
    if (endSessions !== undefined && typeof endSessions !== "boolean")
      return bad("invalid", "endSessions is true or false");
    if (!mayBoards(user)) return bad("forbidden", "a person's access is a forge admin's to reset");
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "resetting access needs an admin token");
    if (action === "end_sessions") {
      const done = endAllSessions(ctx.app, user, username, { dryRun });
      if (!done.ok) return done.error === "not_found" ? bad("not_found", "no such person") : bad("not_allowed", ACCESS_WORDS.notAllowed);
      return good(dryRun ? { ...done.value, says: "This is the plan; nothing changed. Send dryRun: false to do it." } : done.value);
    }
    const done = await resetAccess(ctx.app, user, username, { endAll: endSessions === true, dryRun });
    if (!done.ok) return done.error === "not_found" ? bad("not_found", "no such person") : bad("not_allowed", ACCESS_WORDS.notAllowed);
    const { token, ...rest } = done.value;
    return good(
      token === undefined
        ? { ...rest, says: "This is the plan; nothing changed. Send dryRun: false to make the link." }
        : { ...rest, url: accessUrl(ctx.app, token) },
    );
  },
};
