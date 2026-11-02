import { listAccess } from "../../../actions/access_log.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "access",
  doc: "`{ since?, ua?, path? }`: what outside agents tried: the redacted log of non-browser requests to public paths, newest first; `since` an ISO time (default a day, at most 14 days), `ua` part of the user agent, `path` a prefix; a forge admin's",
  description:
    "Non-browser public-path requests, redacted, newest first (max 500). Forge admin.",
  inputSchema: {
    type: "object",
    properties: {
      since: { type: "string", maxLength: 40 },
      ua: { type: "string", maxLength: 100 },
      path: { type: "string", maxLength: 200 },
    },
  },
  writes: true,
  run(ctx, user, args) {
    const text = (k: string): string | undefined =>
      typeof args[k] === "string" && args[k] !== "" ? (args[k] as string) : undefined;
    const since = text("since");
    const ua = text("ua");
    const path = text("path");
    const listed = listAccess(ctx.app, user, {
      ...(since === undefined ? {} : { since: since.slice(0, 40) }),
      ...(ua === undefined ? {} : { ua: ua.slice(0, 100) }),
      ...(path === undefined ? {} : { path: path.slice(0, 200) }),
    });
    if (!listed.ok) return bad("not_found", "no such tool here");
    return good({ requests: listed.value });
  },
};
