import { scopeAllows } from "../../../core/tokens.ts";
import { NOTIFY_ERRORS, notifyHost, notifyUrlOf, setNotifyUrl } from "../../../crew/notify.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "notify",
  doc: "`{ url? }`: read (its host only), set or, with an empty `url`, turn off your phone notify URL, as Settings does; a person's, saving needs an admin token",
  description: "Read, set or clear your phone notify URL.",
  inputSchema: { type: "object", properties: { url: { type: "string" } } },
  writes: true,
  readsWithout: "url",
  run(ctx, user, args) {
    if (user.kind === "agent") return bad("forbidden", "a notify URL is a person's, not an agent's");
    const { url } = args;
    if (url === undefined) {
      const host = notifyHost(notifyUrlOf(ctx.app.db, user.id));
      return good({ set: host !== undefined, host: host ?? null });
    }
    if (typeof url !== "string") return bad("invalid", "send url as text, or empty to turn it off");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the notify URL needs an admin token");
    const saved = setNotifyUrl(ctx.app.db, user.id, url);
    if (!saved.ok) return bad("invalid", NOTIFY_ERRORS[saved.error]);
    ctx.app.bus.append({ kind: "account.notify_set", actorId: user.id });
    return good({ set: saved.value === "set", host: notifyHost(notifyUrlOf(ctx.app.db, user.id)) ?? null });
  },
};
