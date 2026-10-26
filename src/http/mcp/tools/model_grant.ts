import { SPEND_WORDS } from "../../../actions/spend_words.ts";
import { setAccountGrant } from "../../../actions/model_grant.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "model_grant",
  description:
    "Give a person a monthly model grant (`usdPerMonth`, 0 takes it back). Person admins.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      usdPerMonth: { type: "number", description: "0.01–10000; 0 revokes." },
      dryRun: { type: "boolean" },
    },
    required: ["username", "usdPerMonth"],
  },
  writes: true,
  doc: "`{ username, usdPerMonth, dryRun? }` (a forge admin who is a person): give an account a capped monthly model grant in dollars (0 takes it back); planned unless `dryRun` is false, applying takes an admin token",
  dryByDefault: true,
  run(ctx, user, args) {
    const usd = args["usdPerMonth"];
    const username = args["username"];
    if (typeof username !== "string" || typeof usd !== "number" || !Number.isFinite(usd))
      return bad("invalid", "send a username and usdPerMonth in dollars");
    if (!mayBoards(user)) return bad("forbidden", "a model grant is a forge admin's to give");
    const dryRun = args["dryRun"] !== false;
    if (dryRun)
      return good({
        username,
        usdPerMonth: usd === 0 ? null : usd,
        says: "This is the plan; nothing changed. Send dryRun: false to set it.",
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a model grant needs an admin token");
    const set = setAccountGrant(ctx.app, user, username, usd === 0 ? null : usd);
    if (!set.ok)
      return bad(
        set.error === "invalid_amount" ? "invalid" : "forbidden",
        set.error === "invalid_amount"
          ? SPEND_WORDS.usdPerMonth
          : "no such person, or not one a grant is for",
      );
    return good(set.value);
  },
};
