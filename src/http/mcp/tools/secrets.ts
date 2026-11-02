import { listSecrets, putSecret, removeSecret } from "../../../actions/secrets.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "secrets",
  doc: "`{ scope, ref?, action, name?, value? }` (forge admin): `list` the names and timestamps of the forge's sealed secrets, `set` or `remove` one; `scope` is forge, org or repo, `ref` the org or `owner/name`; a value is never read back",
  description: "Admin: list|set|remove sealed secrets.",
  inputSchema: {
    type: "object",
    properties: {
      scope: { type: "string" },
      ref: { type: "string" },
      action: { type: "string" },
      name: { type: "string" },
      value: { type: "string" },
    },
  },
  writes: true,
  adminOnly: true,
  run(ctx, user, args) {
    // The API asks for an admin token on all three routes; so does this.
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "secrets need an admin token");
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    const scope = str(args["scope"]);
    const ref = str(args["ref"]);
    const name = str(args["name"]);
    const action = args["action"];
    if (action === "list") {
      const listed = listSecrets(ctx.app, user, scope, ref);
      return listed.ok ? good({ items: listed.value }) : bad(listed.error, listed.error);
    }
    if (action === "set") {
      const set = putSecret(ctx.app, user, scope, ref, name, str(args["value"]));
      return set.ok ? good(set.value) : bad(set.error, set.error);
    }
    if (action === "remove") {
      const gone = removeSecret(ctx.app, user, scope, ref, name);
      return gone.ok ? good({ removed: name }) : bad(gone.error, gone.error);
    }
    return bad("invalid", "action is list, set or remove");
  },
};
