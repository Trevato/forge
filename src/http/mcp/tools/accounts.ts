import { listAccounts } from "../../../actions/accounts.ts";
import { roleOf } from "../../../core/roles.ts";
import { getUserByName } from "../../../core/users.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "accounts",
  doc: "`{ cursor?, limit? }`: the forge's accounts, newest first: `username`, `role`, `verified`, `suspended`, `created`, and `next` (a cursor, or null); `limit` 1-50 (default 20); a person admin's",
  description: "Accounts, newest first: role, verified, suspended. `cursor` pages.",
  inputSchema: {
    type: "object",
    properties: {
      cursor: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
  },
  writes: false,
  adminOnly: true,
  run(ctx, user, args) {
    const listed = listAccounts(ctx.app, user);
    if (!listed.ok) return bad("forbidden", "the accounts are a forge admin's to list");
    const given = args["limit"];
    if (given !== undefined && (!Number.isInteger(given) || (given as number) < 1 || (given as number) > 50))
      return bad("invalid", "limit is a whole number from 1 to 50");
    const limit = (given as number | undefined) ?? 20;
    const from = args["cursor"] === undefined ? 0 : Number(args["cursor"]);
    if (!Number.isInteger(from) || from < 0 || typeof args["cursor"] === "boolean")
      return bad("invalid", "that cursor was not issued here");
    const page = listed.value.slice(from, from + limit);
    const next = from + limit < listed.value.length ? String(from + limit) : null;
    return good({
      items: page.map((a) => {
        const who = getUserByName(ctx.app.db, a.username);
        return {
          username: a.username,
          role: who === undefined ? "guest" : roleOf(ctx.app.db, who),
          verified: a.verified,
          suspended: a.suspendedAt !== null,
          created: a.createdAt,
        };
      }),
      next,
    });
  },
};
