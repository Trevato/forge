import { mirrorNow } from "../../../actions/backups_now.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "mirror_now",
  doc: "`{}` (forge admin, admin-scope token): brings the off-box snapshot mirror level now, as the Backups page's button does; answers `{ level, newest?, error?, says }`, `says` worded as the page's flash",
  description: "Admin: bring the snapshot mirror level now.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  async run(ctx, user) {
    const done = await mirrorNow(ctx.app, user);
    return done.ok ? good(done.value) : bad("not_found", "no such tool here");
  },
};
