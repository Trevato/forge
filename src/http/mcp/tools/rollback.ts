import { existsSync } from "node:fs";
import { running } from "../../../kernel/version.ts";
import { releaseDir } from "../../../release/checkout.ts";
import { canRollBackTo, mayRollBack, rollBackTo } from "../../../release/gate.ts";
import { releaseName, releasesByPrefix } from "../../../release/record.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "rollback",
  doc: "`{ sha, dryRun? }`: roll the forge back to a kept release, as /releases does; plans unless `dryRun` is false (from which release to which, and whether the live schema allows it); a person who may roll back, with an admin-scope token, never an agent",
  description: "Plan, then apply, a rollback to a kept release (admin).",
  inputSchema: {
    type: "object",
    properties: { sha: { type: "string", maxLength: 40 }, dryRun: { type: "boolean" } },
    required: ["sha"],
  },
  writes: true,
  needsAdminScope: true,
  async run(ctx, user, args) {
    if (!mayRollBack(ctx.app, user))
      return bad("forbidden", "a rollback is for a person who may write the forge's repository and administer it, not an agent");
    const given = args["sha"];
    if (typeof given !== "string" || !/^[0-9a-f]{7,40}$/.test(given.toLowerCase()))
      return bad("invalid", "sha is a kept release's commit, 7 to 40 hex digits");
    const prefix = given.toLowerCase();
    const matches = releasesByPrefix(ctx.app.db, prefix);
    if (matches.length > 1) return bad("invalid", "that sha names more than one release; give more digits");
    const found = matches[0];
    if (found === undefined || !existsSync(releaseDir(ctx.app.config.dataDir, found.sha)))
      return bad("not_found", "no kept release has that sha");
    const live = running().commit;
    if (live !== null && found.sha === live) return bad("invalid", "that release is the one running");
    if (!(await canRollBackTo(ctx.app, found)))
      return bad("refused", `${releaseName(found)} cannot be rolled back to: it failed its preflight, or predates the live schema and would need a down-migration`);
    const plan = { from: live === null ? null : live.slice(0, 12), to: releaseName(found), allowed: true };
    if (args["dryRun"] !== false)
      return good({ dryRun: true, ...plan, says: `Would roll back from ${plan.from ?? "this release"} to ${plan.to}; pass dryRun false to do it.` });
    const done = await rollBackTo(ctx.app, user, found.sha);
    if (!done.ok) return bad("failed", done.line);
    return good({ dryRun: false, ...plan, says: `Rolled back to ${plan.to}; it reads healthy.` });
  },
};
