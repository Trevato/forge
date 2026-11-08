import { ABILITIES, roleOf, rowOf } from "../../../core/roles.ts";
import { LAST_WAY_IN, removeOwnPasskey } from "../../../actions/passkeys.ts";
import { listPasskeys } from "../../../core/passkeys.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "whoami_can",
  doc: "`{ kind?, remove? }`: your role and that role's row of the roles table, each ability yes or no; `kind: \"passkeys\"` lists your own passkeys (`{ items }`: id, name, created, lastUsed), people only; `remove: id` with `kind: \"passkeys\"` removes one of them, as Settings → Passkeys does (an admin-scope token, never an agent)",
  description:
    "What you can do: your role and its roles-table row, yes or no each.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["role", "passkeys"] },
      remove: { type: "string" },
    },
  },
  writes: true,
  readsWithout: "remove",
  run: (ctx, user, args) => {
    const kind = args["kind"] ?? "role";
    if (args["remove"] !== undefined && kind !== "passkeys") return bad("invalid", "remove goes with kind: passkeys");
    if (kind === "passkeys") {
      if (user.kind === "agent") return bad("forbidden", "an agent has no passkeys");
      const remove = args["remove"];
      if (remove !== undefined) {
        if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
          return bad("forbidden", "removing a passkey needs an admin-scope token");
        if (typeof remove !== "string" || remove === "" || remove.length > 64)
          return bad("bad_args", "remove is a passkey id");
        const gone = removeOwnPasskey(ctx.app, user, remove);
        if (!gone.ok)
          return gone.error === "last_way_in" ? bad("refused", LAST_WAY_IN) : bad("not_found", "No such passkey.");
        return good({ id: remove, says: "Passkey removed." });
      }
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
