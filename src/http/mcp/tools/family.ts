import { familyView } from "../../../spawn/family.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "family",
  doc: "the forge that sent this one and, for a site admin, those it sent, with state and version",
  description:
    "The forge that sent this one and, for a site admin, those it sent, with state and version.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  async run(ctx, user) {
    return good(await familyView(ctx.app, user.isAdmin === true));
  },
};
