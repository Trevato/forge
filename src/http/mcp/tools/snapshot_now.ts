import { snapshotsOf } from "../../../snapshot/service.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { fileSize } from "../../../web/ui.ts";
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
    const svc = snapshotsOf(ctx.app);
    if (svc?.store === undefined)
      return bad("no_store", "This forge has nowhere to put a snapshot.");
    try {
      const m = await svc.now();
      return good({
        name: m.name,
        repos: m.repos,
        apps: m.apps,
        bytes: m.bytes,
        says: `Snapshot ${m.name} taken: ${m.repos} repositories, ${m.apps} apps, ${fileSize(m.bytes)}.`,
      });
    } catch (error) {
      return bad("failed", `The snapshot failed: ${String(error)}`);
    }
  },
};
