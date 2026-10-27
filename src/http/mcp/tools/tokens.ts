import { listTokens } from "../../../core/tokens.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "tokens",
  doc: "your own API tokens, as `GET /api/v1/tokens` lists them: id, name, scope, created and last used; never a token or its hash",
  description: "Your API tokens, no secrets.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    return good({ items: listTokens(ctx.app.db, user.id) });
  },
};
