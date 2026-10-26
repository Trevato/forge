import { scopeAllows } from "../../../core/tokens.ts";
import { setTelemetryGrant } from "../../../actions/telemetry.ts";
import { good, bad, type Tool, mayBoards } from "../shared.ts";

export const tool: Tool = {
  name: "telemetry_grant",
  doc: "`{ agent, on }`: grant an agent `telemetry:read`, or take it back with `false`, as the Telemetry page does; a person admin's, with an admin token; answers `says`",
  description: "Grant an agent telemetry:read, or take it back with `on: false`.",
  inputSchema: {
    type: "object",
    properties: { agent: { type: "string" }, on: { type: "boolean" } },
    required: ["agent", "on"],
  },
  writes: true,
  adminOnly: true,
  needsAdminScope: true,
  run(ctx, user, args) {
    const { agent, on } = args;
    if (typeof agent !== "string" || typeof on !== "boolean")
      return bad("invalid", "send an agent name and on, true or false");
    if (!mayBoards(user)) return bad("forbidden", "telemetry:read is a forge admin's to grant");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "granting needs an admin token");
    const set = setTelemetryGrant(ctx.app, user, agent, on);
    if (!set.ok)
      return set.error === "not_an_agent"
        ? bad("invalid", "Only an agent account can be granted telemetry:read.")
        : bad("not_found", "no such account");
    const { username } = set.value;
    return good({ agent: username, on, says: `${username} ${on ? "may now read" : "no longer reads"} telemetry.` });
  },
};
