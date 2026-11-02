import { addAccount, allowWrite, auditAccount, removeAccount, renameAccount, reverify, rotateAccount } from "../../../actions/cloud.ts";
import { PROVIDERS } from "../../../cloud/providers.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "cloud_account",
  doc: "`{ verb, provider, name, value?, to?, allowed?, repo? }`: change a cloud account: `attach` or `rotate` a token (`value`), `verify` it, `rename` it (`to`), `remove` it, `allow_writes` (`allowed` true or false) or `audit` (`repo` owner/name); a forge admin with an admin-scope token; answers a one-line `says`",
  description:
    "Change a cloud account by `verb` (admin).",
  inputSchema: {
    type: "object",
    properties: {
      verb: { type: "string", enum: ["attach", "verify", "rotate", "rename", "remove", "allow_writes", "audit"] },
      provider: { type: "string", enum: [...PROVIDERS] },
      name: { type: "string", maxLength: 32 },
      value: { type: "string", maxLength: 4096, description: "For attach, rotate." },
      to: { type: "string", maxLength: 32 },
      allowed: { type: "boolean" },
      repo: { type: "string", maxLength: 200 },
    },
    required: ["verb", "provider", "name"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (!user.isAdmin) return bad("not_found", "no such tool here");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing cloud accounts needs an admin-scope token");
    const verb = str(args["verb"]);
    const [provider, name] = [str(args["provider"]), str(args["name"])];
    const value = str(args["value"]);
    if (str(args["verb"]) === "allow_writes" && typeof args["allowed"] !== "boolean")
      return bad("bad_args", "allow_writes needs allowed: true or false");
    const done =
      verb === "attach"
        ? await addAccount(ctx.app, user, provider, name, value)
        : verb === "rotate"
          ? await rotateAccount(ctx.app, user, provider, name, value)
          : verb === "verify"
            ? await reverify(ctx.app, user, provider, name)
            : verb === "rename"
              ? renameAccount(ctx.app, user, provider, name, str(args["to"]))
              : verb === "remove"
                ? removeAccount(ctx.app, user, provider, name)
                : verb === "allow_writes"
                  ? allowWrite(ctx.app, user, provider, name, args["allowed"] === true)
                  : verb === "audit"
                    ? await auditAccount(ctx.app, user, provider, name, str(args["repo"]))
                    : undefined;
    if (done === undefined) return bad("bad_verb", "verb is attach, verify, rotate, rename, remove, allow_writes or audit");
    if (!done.ok) return bad("refused", done.error);
    const v = done.value as unknown;
    const said =
      typeof v === "string"
        ? v
        : verb === "audit"
          ? `${(v as { opened: number }).opened} issue(s) opened, ${(v as { found: number }).found} found`
          : "done";
    return good({ says: `${verb} ${provider}/${name}: ${said}.` });
  },
};
