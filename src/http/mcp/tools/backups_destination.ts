import { forgetDestination, invalidField, saveDestination, type DestinationInput } from "../../../actions/destination.ts";
import { resolveDestination } from "../../../snapshot/destination.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "backups_destination",
  doc: "`{ action, endpoint?, bucket?, region?, accessKey?, secretKey? }`: `set` or `forget` where snapshots go, validated as the Backups page does; answers `{ kind, place, says }`, never a key; a person admin's, with an admin token",
  description: "Admin: snapshot destination.",
  inputSchema: {
    type: "object",
    properties: {
      action: { enum: ["set", "forget"] },
      endpoint: { type: "string" },
      bucket: { type: "string" },
      region: { type: "string" },
      accessKey: { type: "string" },
      secretKey: { type: "string" },
    },
    required: ["action"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const action = args["action"];
    if (action !== "set" && action !== "forget") return bad("invalid", "action is set or forget");
    let says: string;
    if (action === "forget") {
      if (!forgetDestination(ctx.app, user).ok) return bad("forbidden", "the snapshot destination is a forge admin's");
      says = "The sealed destination is cleared.";
    } else {
      const field = (k: string): string | undefined => {
        const v = args[k];
        return v === undefined ? "" : typeof v === "string" ? v.trim() : undefined;
      };
      const input = {
        endpoint: field("endpoint"),
        bucket: field("bucket"),
        region: field("region"),
        accessKey: field("accessKey"),
        secretKey: field("secretKey"),
      };
      if (Object.values(input).some((v) => v === undefined)) return bad("invalid", "each field is a string");
      const given = input as DestinationInput;
      const refused = invalidField(given);
      if (refused) return bad("invalid", refused);
      const saved = saveDestination(ctx.app, user, given);
      if (!saved.ok)
        return saved.error === "not_found"
          ? bad("forbidden", "the snapshot destination is a forge admin's")
          : bad("invalid", saved.error);
      says = saved.value;
    }
    const dest = resolveDestination({ db: ctx.app.db, dataDir: ctx.app.config.dataDir, bus: ctx.app.bus });
    return good({ kind: dest?.source ?? "none", place: dest?.store.where ?? "", says });
  },
};
