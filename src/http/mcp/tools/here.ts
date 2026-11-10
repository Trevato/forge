import { appsRuntime } from "../../../apps/runtime.ts";
import { hereOf } from "../../../apps/here.ts";
import { manifestFor } from "../../../actions/here.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "here",
  description:
    "What you may do on a forge page; given an app's link, what its /__forge/ door shows.",
  doc: "`{ url }`: on a forge page, what you may do there as who you are, each action with its route and tool; on the link of one of this forge's app hosts, what its `/__forge/` door shows: `{ app, repo, audience: { level, who, sentence } (only when you may read the repository), environment, pull: { number, title } or null, working: [names], links: { home, repo, report } }`; a foreign host, or a private app you may not enter, is refused like a missing page",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", maxLength: 2000 } },
    required: ["url"],
  },
  writes: false,
  run(ctx, user, args) {
    const raw = str(args["url"]);
    const runtime = appsRuntime(ctx.app);
    const door = runtime === undefined || raw.length > 2000 ? undefined : hereOf(runtime, raw, user);
    if (door !== undefined) return good(door);
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
