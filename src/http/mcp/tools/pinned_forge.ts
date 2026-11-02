import { checkPinned, deployPinned, pinnedForges, rollbackPinned, updatePinned } from "../../../actions/pinned.ts";
import { TARGETS } from "../../../cloud/targets.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "pinned_forge",
  doc: "`{ verb, name?, target?, account?, app?, source?, version?, config? }`: a pinned forge on the owner's cloud has no crew and no automatic release. `list` shows them with every recorded change and the targets (what runs, what it costs, what is refused); `deploy` puts one on `target` with a cloud `account` (writes allowed) serving `app` owner/name from `source` at `version`; `update` is the only way its `version` or `config` change; `rollback` goes back one; `check` reads the droplet's address back and probes it (`url`, `healthy`). A forge admin with an admin-scope token",
  description: "Pinned forges on your cloud: list, deploy, update, rollback, check (admin).",
  inputSchema: {
    type: "object",
    properties: {
      verb: { type: "string", enum: ["list", "deploy", "update", "rollback", "check"] },
      name: { type: "string", maxLength: 40 },
      target: { type: "string", enum: TARGETS.map((t) => t.id) },
      account: { type: "string", maxLength: 32 },
      app: { type: "string", maxLength: 140 },
      source: { type: "string", maxLength: 300 },
      version: { type: "string", maxLength: 40, description: "A 40-character commit id or a tag like v1.2.3." },
      config: { type: "object", description: "Plain NAME: value settings; never a secret." },
    },
    required: ["verb"],
  },
  // Marked a write so a `ro` token never lists the owner's cloud arrangements.
  writes: true,
  async run(ctx, user, args) {
    if (!user.isAdmin) return bad("not_found", "no such tool here");
    const verb = str(args["verb"]);
    if (verb === "list") {
      const seen = pinnedForges(ctx.app, user);
      return seen.ok ? good({ items: seen.value, targets: TARGETS }) : bad("not_found", "no such tool here");
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing a pinned forge needs an admin-scope token");
    const name = str(args["name"]);
    const done =
      verb === "deploy"
        ? await deployPinned(ctx.app, user, {
            name, target: str(args["target"]), account: str(args["account"]), app: str(args["app"]),
            source: str(args["source"]), version: str(args["version"]), config: args["config"],
          })
        : verb === "update"
          ? await updatePinned(ctx.app, user, name, {
              version: args["version"] === undefined ? undefined : str(args["version"]),
              config: args["config"],
            })
          : verb === "rollback"
            ? await rollbackPinned(ctx.app, user, name)
            : verb === "check"
              ? await checkPinned(ctx.app, user, name)
              : undefined;
    if (done === undefined) return bad("bad_verb", "verb is list, deploy, update, rollback or check");
    if (!done.ok) return bad("refused", done.error);
    return good({ says: `${verb} ${name}: now ${done.value.version}, ${done.value.state}${done.value.url ? ` at ${done.value.url}` : ""}.`, forge: done.value });
  },
};
