import { allowRequest, declineRequest, listRequests } from "../../../actions/requests.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "account_requests",
  doc: "`{ username?, answer? }`: the strangers waiting for an account (name, note, when, from where); with `username` and `answer` `allow` or `decline`, answer one; a forge admin's, and answering needs an admin token",
  description: "List who asked for an account and wait; `answer: allow|decline` answers one.",
  inputSchema: {
    type: "object",
    properties: { username: { type: "string" }, answer: { type: "string", enum: ["allow", "decline"] } },
  },
  writes: true,
  run(ctx, user, args) {
    if (!mayBoards(user)) return bad("not_found", "no such tool here");
    const { username, answer } = args;
    if (username === undefined && answer === undefined) {
      const listed = listRequests(ctx.app, user);
      return listed.ok ? good({ waiting: listed.value }) : bad("not_found", "no such tool here");
    }
    if (typeof username !== "string" || (answer !== "allow" && answer !== "decline"))
      return bad("invalid", "send a username and answer: allow or decline");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "answering a request needs an admin token");
    const done = (answer === "allow" ? allowRequest : declineRequest)(ctx.app, user, username);
    if (done.ok) return good({ username: done.value.username, state: done.value.state });
    return done.error === "not_waiting" ? bad("not_waiting", "that request is not waiting") : bad("not_found", "no such person");
  },
};
