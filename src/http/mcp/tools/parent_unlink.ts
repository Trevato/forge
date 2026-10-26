import { scopeAllows } from "../../../core/tokens.ts";
import { LAST_WAY_IN, parentIssuerOf, unlinkParent } from "../../../core/federation.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "parent_unlink",
  doc: "no input: stop signing in through the parent forge, as Settings does; refused when it is the account's last way in, and \"Nothing to unlink.\" when nothing is linked; an admin token",
  description: "Unlink parent-forge sign-in.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  run(ctx, user) {
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "unlinking needs an admin token");
    const issuer = parentIssuerOf(ctx.app.config);
    const done = issuer === undefined ? undefined : unlinkParent(ctx.app.db, user.id, issuer);
    if (done === undefined || (done.ok && done.value === "none")) return good({ says: "Nothing to unlink." });
    if (!done.ok) return bad("last_way_in", LAST_WAY_IN);
    ctx.app.bus.append({ kind: "account.parent_unlinked", actorId: user.id });
    return good({ says: "Unlinked." });
  },
};
