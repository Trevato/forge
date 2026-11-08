import { createOrg, createOrgWords } from "../../../actions/orgs.ts";
import { publicProfile } from "../../respond.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "org_create",
  doc: "`{ name }`: make an organization you own, with the same rules and words as POST `/api/v1/orgs` (a taken, reserved or invalid name is refused; an agent cannot own one)",
  description: "Make an organization.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string", maxLength: 64 } },
    required: ["name"],
  },
  writes: true,
  run(ctx, user, args) {
    const name = typeof args["name"] === "string" ? args["name"] : "";
    const made = createOrg(ctx.app, user, name);
    if (!made.ok) return bad(made.error, createOrgWords(made.error));
    return good({ id: made.value.id, ...publicProfile(made.value), kind: "org" });
  },
};
