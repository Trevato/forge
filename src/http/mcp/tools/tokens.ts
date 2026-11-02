import { listTokensWithClients } from "../../../core/oauth.ts";
import { good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "tokens",
  doc: "your own API tokens, as `GET /api/v1/tokens` lists them: id, name, scope, created and last used, and `oauthClient`: the harness that holds a token minted through OAuth, null for a hand-made one; never a token or its hash",
  description: "Your API tokens, no secrets.",
  inputSchema: { type: "object", properties: {} },
  writes: false,
  run(ctx, user) {
    return good({ items: listTokensWithClients(ctx.app.db, user.id) });
  },
};
