import { forgeViewText } from "../../../actions/forge_view.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "forge_view",
  doc: "the forge as one read-only picture: counts, the apps you may see, the crew's runs with their stations, and health; the same body as GET /api/v1/forge/view, built at most once per two seconds per caller",
  description: "The forge as one picture: counts, apps, runs with stations, health.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run: (ctx, user) => good(JSON.parse(forgeViewText(ctx, user))),
};
