import { SPEND_WORDS } from "../../../actions/spend_words.ts";
import { setAccountCeilings } from "../../../actions/model_grant.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "model_ceiling",
  description:
    "Set an account's daily and per-run model spend ceilings in dollars.",
  inputSchema: {
    type: "object",
    properties: {
      username: { type: "string" },
      dailyUsd: { type: ["number", "null"], description: "0.01–10000; null clears." },
      perRunUsd: { type: ["number", "null"], description: "0.01–10000; null clears." },
      dryRun: { type: "boolean" },
    },
    required: ["username", "dailyUsd", "perRunUsd"],
  },
  writes: true,
  doc: "`{ username, dailyUsd, perRunUsd, dryRun? }` (a forge admin who is a person): cap an account's daily and per-run model spend in dollars (both `null` clears); planned unless `dryRun` is false, applying takes an admin token",
  dryByDefault: true,
  run(ctx, user, args) {
    const { username, dailyUsd, perRunUsd } = args;
    if (
      typeof username !== "string" ||
      !(dailyUsd === null || (typeof dailyUsd === "number" && Number.isFinite(dailyUsd))) ||
      !(perRunUsd === null || (typeof perRunUsd === "number" && Number.isFinite(perRunUsd)))
    )
      return bad("invalid", "send a username, dailyUsd and perRunUsd in dollars (both null takes them back)");
    if (!mayBoards(user)) return bad("forbidden", "a ceiling is a forge admin's to set");
    if (args["dryRun"] !== false)
      return good({
        username,
        dailyUsd,
        perRunUsd,
        says: "This is the plan; nothing changed. Send dryRun: false to set it.",
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a ceiling needs an admin token");
    const set = setAccountCeilings(ctx.app, user, username, dailyUsd, perRunUsd);
    if (!set.ok)
      return set.error === "invalid_amount"
        ? bad("invalid", SPEND_WORDS.ceilings)
        : bad("forbidden", "no such account");
    return good(set.value);
  },
};
