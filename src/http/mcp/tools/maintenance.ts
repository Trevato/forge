import { prepare, resumeNow, status } from "../../../maintenance/service.ts";
import { duties } from "../../../maintenance/duties.ts";
import { statusWithStandby } from "../../../maintenance/standby.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { dutyStates, switchDuty } from "../../../maintain/pause.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "maintenance",
  doc: "`action` is `status` (default), `prepare`, `resume`, `pause-duty` or `resume-duty` (with `duty`, a name from `status`); `reason` (prepare only, at most 200 characters) is shown to visitors; a forge admin, and prepare and resume need an admin-scope token; answers the status `{ phase, since?, reason?, backup?, working, says, standby: { state, says }, duties }`",
  description: "Prepare the forge for a power-off, check the drain, or end maintenance (admin).",
  inputSchema: {
    type: "object",
    properties: { action: { type: "string", enum: ["status", "prepare", "resume", "pause-duty", "resume-duty"] }, duty: { type: "string", maxLength: 64 }, reason: { type: "string", maxLength: 200 } },
  },
  writes: true,
  async run(ctx, user, args) {
    if (!user.isAdmin) return bad("not_found", "no such tool here");
    const action = args["action"] ?? "status";
    if (action === "status") return good({ ...(await statusWithStandby(status(ctx.app))), duties: [...duties(ctx.app.config.dataDir).map((d) => d.says), ...dutyStates(ctx.app.db).map((d) => d.says)] });
    if (action === "pause-duty" || action === "resume-duty") {
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "maintenance needs an admin-scope token");
      const r = switchDuty(ctx.app.db, args["duty"], action === "pause-duty", user.username);
      return r.ok ? good({ says: r.says }) : bad(r.code, r.says);
    }
    if (action !== "prepare" && action !== "resume") return bad("invalid", "action is status, prepare, resume, pause-duty or resume-duty");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "maintenance needs an admin-scope token");
    if (action === "resume") {
      const r = resumeNow(ctx.app, user);
      return r.ok ? good(r.value) : bad(r.error.code, r.error.says);
    }
    const reason = typeof args["reason"] === "string" ? args["reason"] : "";
    const r = await prepare(ctx.app, user, reason);
    return r.ok ? good(r.value) : bad(r.error.code, r.error.says);
  },
};
