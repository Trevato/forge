import { MAX_REASON } from "../../../keeper/hold.ts";
import { releaseNowAs } from "../../../keeper/now.ts";
import { bad, good, str, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "release_now",
  doc: "`{ reason }`: ask the release keeper (#7557) to cut main now, at its next tick (within a minute), outside the 30-minute spacing and past a running merge queue or snapshot, for a hotfix. The reason stays on the release. It still waits for a release in flight to be proven, for a hold and for room on the disk. A person who may roll back, with an admin-scope token, never an agent",
  description: "Cut a release now, with a reason (admin).",
  inputSchema: { type: "object", properties: { reason: { type: "string", maxLength: MAX_REASON } }, required: ["reason"] },
  writes: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const asked = releaseNowAs(ctx.app, user, str(args["reason"]));
    return asked.ok ? good({ releaseNow: asked.value }) : bad(asked.error, asked.message);
  },
};
