import { snapshotNow } from "../../../actions/backups_now.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "snapshot_now",
  doc: "no arguments: take a snapshot now, as the Backups page's button does; a forge admin with an admin-scope token; answers `{ name, repos, apps, bytes, says }`",
  description: "Take a snapshot now, as Backups does (admin).",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  async run(ctx, user) {
    if (!user.isAdmin) return bad("not_found", "no such tool here");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a snapshot needs an admin-scope token");
    const taken = await snapshotNow(ctx.app, user);
    return taken.ok ? good(taken.value) : bad(taken.error.code, taken.error.says);
  },
};
