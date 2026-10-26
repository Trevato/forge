import { manifestFor } from "../../../actions/here.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "here",
  description:
    "What you can do on a forge page, as who you are: each open action with its HTTP route and MCP tool.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", maxLength: 2000 } },
    required: ["url"],
  },
  writes: false,
  run(ctx, user, args) {
    const raw = str(args["url"]);
    const parsed = URL.parse(raw, ctx.url.origin);
    if (parsed === null || parsed.origin !== ctx.url.origin)
      return bad("not_found", "not a page of this forge");
    const found = manifestFor(
      ctx.app,
      user,
      ctx.auth.via === "token" ? ctx.auth.scope : undefined,
      ctx.url.origin,
      parsed.pathname,
    );
    return found.ok
      ? good(found.value)
      : bad("not_found", "no such page here, or it is not visible to you");
  },
};
