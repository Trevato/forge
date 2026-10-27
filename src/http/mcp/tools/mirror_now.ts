import { snapshotsOf } from "../../../snapshot/service.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "mirror_now",
  doc: "`{}` (forge admin, admin-scope token): brings the off-box snapshot mirror level now, as the Backups page's button does; answers `{ level, newest?, error?, says }`, `says` worded as the page's flash",
  description: "Admin: bring the snapshot mirror level now.",
  inputSchema: { type: "object", properties: {} },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  async run(ctx) {
    const state = await snapshotsOf(ctx.app)?.mirrorNow();
    if (state === undefined)
      return good({ level: false, says: "This forge has no mirror to bring level." });
    if (state.sourceError !== undefined)
      return good({
        level: false,
        error: state.sourceError,
        says: `The snapshots could not be read from the destination, so the mirror was not touched: ${state.sourceError}`,
      });
    if (state.failingSince === undefined)
      return good({
        level: true,
        ...(state.newest ? { newest: state.newest } : {}),
        says: `The mirror is level${state.newest ? ` at ${state.newest}` : ""}.`,
      });
    return good({
      level: false,
      ...(state.newest ? { newest: state.newest } : {}),
      error: state.error ?? "unknown reason",
      says: `The mirror is not level: ${state.error ?? "unknown reason"}`,
    });
  },
};
