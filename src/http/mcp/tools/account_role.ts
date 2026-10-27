import { SPEND_WORDS } from "../../../actions/spend_words.ts";
import { setRole } from "../../../actions/roles.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "account_role",
  doc: "`{ username, role, usdPerMonth?, dryRun? }`: make a person a `member`, or a `guest` again, with an optional starter allowance (`usdPerMonth`, 0.01 to 10000, promoting only); planned first (`dryRun` is true unless `false`)",
  description:
    "Make a person a member or a guest; promoting may grant `usdPerMonth`.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      role: { type: "string", enum: ["member", "guest"] },
      usdPerMonth: { type: ["number", "null"], description: "0.01–10000 or none." },
      dryRun: { type: "boolean" },
    },
    required: ["username", "role"],
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const { username, role, usdPerMonth } = args;
    if (
      typeof username !== "string" ||
      (role !== "member" && role !== "guest") ||
      !(usdPerMonth === undefined || usdPerMonth === null || (typeof usdPerMonth === "number" && Number.isFinite(usdPerMonth)))
    )
      return bad("invalid", 'send a username and a role, "member" or "guest"');
    if (!mayBoards(user)) return bad("forbidden", "a role is a forge admin's to set");
    const usd = typeof usdPerMonth === "number" ? usdPerMonth : null;
    if (args["dryRun"] !== false)
      return good({
        username,
        role,
        usdPerMonth: usd,
        says: "This is the plan; nothing changed. Send dryRun: false to set it.",
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a role needs an admin token");
    const set = setRole(ctx.app, user, username, role, usd);
    if (!set.ok)
      return bad(
        set.error === "invalid_amount" ? "invalid" : "forbidden",
        set.error === "invalid_amount"
          ? SPEND_WORDS.usdPerMonth
          : "no such person, or not one a role is for",
      );
    return good(set.value);
  },
};
