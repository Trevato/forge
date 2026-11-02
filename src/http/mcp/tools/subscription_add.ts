import { addSubscription } from "../../../core/subscriptions.ts";
import { addRefusal } from "../../../core/subscriptions_words.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "subscription_add",
  doc: "`{ name, token, apiBase? }` (forge admin): put a Claude account in the crew's pool, as the Subscriptions page does, with its refusals; answers `{ id, name, says }`; the token is never read back",
  description: "Admin: add a Claude login.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, token: { type: "string" }, apiBase: { type: "string" } },
    required: ["name", "token"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const name = str(args["name"]);
    const added = addSubscription(ctx.app.db, ctx.app.config.dataDir, {
      name,
      token: str(args["token"]).trim(),
      apiBase: str(args["apiBase"]).trim(),
      createdBy: user.id,
    });
    if (!added.ok) return bad(added.error, addRefusal(added.error, name));
    return good({
      id: added.value.id,
      name: added.value.name,
      says: `${added.value.name} is in the pool. Grant it to a repository under its Settings → Crew, or to an organization on its page.`,
    });
  },
};
