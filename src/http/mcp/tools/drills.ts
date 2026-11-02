import { drillRows, listResilience } from "../../../actions/resilience.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "drills",
  doc: "each failure domain: `key`, what breaks, its last drill's time, green or red and why (or why it is not drilled), and the `command` that runs it; a forge admin who is a person only (`forbidden` otherwise), as Settings → Backups says them",
  description: "Failure domains: last drill, verdict, command. Admin.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    const listed = listResilience(ctx.app, user);
    if (!listed.ok) return bad("forbidden", "failure domains are for a forge admin who is a person");
    const origin = ctx.app.config.url ?? ctx.url.origin;
    return good(drillRows(listed.value, origin));
  },
};
