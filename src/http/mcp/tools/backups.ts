import { snapshotsOf } from "../../../snapshot/service.ts";
import { resolveDestination, scrubReason, sealedTarget } from "../../../snapshot/destination.ts";
import { mirrorNeed } from "../../../snapshot/mirror.ts";
import { s3FromEnv } from "../../../snapshot/store.ts";
import { listSnapshots } from "../../../snapshot/snapshot.ts";
import { backupVerdict } from "../../../snapshot/bucket.ts";
import { lastDrill } from "../../../snapshot/drills.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "backups",
  doc: "where snapshots go (`destination`: `kind` sealed, dir or env, and `place`, never a credential; `null` with the Backups page's sentence when none), `verdict` (state, line, reasons, lanes with newest object, drill: read from the bucket, red past 26 h), the last fourteen snapshots (`key`, `at`, `bytes`) and the off-box `mirror`'s state; a forge admin's, as /settings/backups",
  description: "Admin: snapshot destination, recent, mirror.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  adminOnly: true,
  async run(ctx, user) {
    if (!user.isAdmin) return bad("not_found", "not found");
    const dest = resolveDestination({ db: ctx.app.db, dataDir: ctx.app.config.dataDir, bus: ctx.app.bus, attempts: 1 });
    const svc = snapshotsOf(ctx.app);
    const state = svc?.mirrored();
    const need = mirrorNeed(state, Date.now());
    const mirror = {
      place: svc?.mirror?.where ?? null,
      reachable: state?.reachable ?? null,
      newest: state?.newest ?? null,
      syncedAt: state?.syncedAt ?? null,
      says: need?.sentence ?? null,
    };
    const verdict = backupVerdict(ctx.app.config.dataDir, lastDrill(ctx.app.db));
    if (!dest)
      return good({
        verdict,
        destination: null,
        says: "nothing — no snapshots are taken",
        snapshots: [],
        mirror,
      });
    let snapshots: { key: string; at: string; bytes: number }[] = [];
    let listing: string | undefined;
    try {
      snapshots = (await listSnapshots(dest.store))
        .slice(0, 14)
        .map((m) => ({ key: m.name, at: m.finishedAt, bytes: m.bytes }));
    } catch (error) {
      const sources = { db: ctx.app.db, dataDir: ctx.app.config.dataDir, bus: ctx.app.bus };
      const target = dest.source === "sealed" ? sealedTarget(sources) : dest.source === "env" ? s3FromEnv() : undefined;
      listing = scrubReason(target, error);
    }
    return good({
      verdict,
      destination: { kind: dest.source, place: dest.store.where },
      snapshots,
      ...(listing === undefined ? {} : { listing }),
      mirror,
    });
  },
};
