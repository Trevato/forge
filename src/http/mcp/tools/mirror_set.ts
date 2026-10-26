import { forgetMirror, saveMirror } from "../../../actions/mirror.ts";
import { snapshotsOf } from "../../../snapshot/service.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "mirror_set",
  doc: "`{ action, endpoint?, bucket?, region?, accessKey?, secretKey? }` (forge admin, admin-scope token): `set` seals the off-box snapshot mirror, `forget` clears it; the Backups page's rules and refusals, a blank field keeps what was sealed; answers `{ place, says }`, never a key",
  description: "Admin: set or forget the snapshot mirror.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      endpoint: { type: "string" },
      bucket: { type: "string" },
      region: { type: "string" },
      accessKey: { type: "string" },
      secretKey: { type: "string" },
    },
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const place = (): string | null => snapshotsOf(ctx.app)?.mirror?.where ?? null;
    if (args["action"] === "forget") {
      const gone = forgetMirror(ctx.app, user);
      if (!gone.ok) return bad("not_found", "not found");
      return good({ place: place(), says: "The sealed mirror is cleared." });
    }
    if (args["action"] !== "set") return bad("invalid", "action is set or forget");
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
    if (Object.values(input).some((v) => v === undefined))
      return bad("invalid", "the fields are strings");
    const saved = saveMirror(ctx.app, user, input as Record<keyof typeof input, string>);
    if (!saved.ok) return bad(saved.error === "not_found" ? "not_found" : "invalid", saved.error);
    return good({ place: place(), says: saved.value });
  },
};
