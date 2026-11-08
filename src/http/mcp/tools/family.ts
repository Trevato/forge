import { familyView } from "../../../spawn/family.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "family",
  doc: "`{}`: `{ parent, here, children, more }`, the forge that sent this one (`parent`: `{ url, host, behind }`, `null` when none), this one (`here`: `{ host, version }`) and, for a site admin, those it sent (`children`, each with state, version, `apps` and `placement`; `more` the count not listed); takes no arguments",
  description:
    "The forge that sent this one and, for a site admin, those it sent, with state, version.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  async run(ctx, user) {
    return good(await familyView(ctx.app, user.isAdmin === true));
  },
};
