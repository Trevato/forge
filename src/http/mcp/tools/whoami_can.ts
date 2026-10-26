import { ABILITIES, roleOf, rowOf } from "../../../core/roles.ts";
import { listPasskeys } from "../../../core/passkeys.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "whoami_can",
  doc: "`{ kind? }`: your role and that role's row of the roles table, each ability yes or no; `kind: \"passkeys\"` lists your own passkeys (`{ items }`: id, name, created, lastUsed), people only",
  description:
    "What you can do: your role and its roles-table row, yes or no each.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["role", "passkeys"] },
    },
  },
  writes: false,
  run: (ctx, user, args) => {
    const kind = args["kind"] ?? "role";
    if (kind === "passkeys") {
      if (user.kind === "agent") return bad("forbidden", "an agent has no passkeys");
      return good({
        items: listPasskeys(ctx.app.db, user.id).map((k) => ({
          id: k.id,
          name: k.name,
          created: k.createdAt,
          lastUsed: k.lastUsedAt,
        })),
      });
    }
    if (kind !== "role") return bad("invalid", "kind is one of: role, passkeys");
    const role = roleOf(ctx.app.db, user);
    return good({ username: user.username, role, can: rowOf(role), abilities: ABILITIES });
  },
};
