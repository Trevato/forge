import { scopeAllows } from "../../core/tokens.ts";
import type { User } from "../../core/users.ts";
import { editableHosts, envHosts, mayEditTrustedHosts, rejectedSentence, updateTrustedHosts } from "../../origins/trusted-hosts.ts";
import { good, bad, type Answer, type Args, type Tool } from "./shared.ts";

type Ctx = Parameters<Tool["run"]>[0];

/** The `origins` tool's `hosts` action: Settings → Connected accounts' internal-host list, for a forge admin's admin-scope token. */
export function trustedHosts(ctx: Ctx, user: User, args: Args): Answer {
  if (!mayEditTrustedHosts(user)) return bad("forbidden", "Only a forge admin sets this.");
  if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
    return bad("forbidden", "trusted hosts need an admin-scope token");
  const hosts = args["hosts"];
  if (hosts === undefined) return good({ hosts: editableHosts(), fromEnv: envHosts() });
  if (typeof hosts !== "string") return bad("invalid", "`hosts` is text, one host name per line");
  const saved = updateTrustedHosts(ctx.app.db, user, hosts);
  if (!saved.ok)
    return saved.error === "forbidden"
      ? bad("forbidden", "Only a forge admin sets this.")
      : bad("invalid", rejectedSentence(saved.rejected));
  return good({ hosts: saved.hosts, fromEnv: envHosts() });
}
