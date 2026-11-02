import { scopeAllows } from "../../../core/tokens.ts";
import { deleteOriginApp, listOriginApps, registerOriginApp } from "../../../actions/origins.ts";
import { connectMessage } from "../../api.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "origin_apps",
  doc: "`{ action, id?, host?, kind?, clientId?, clientSecret? }`: `list` your OAuth apps for connecting origins, `add` one (a `host`, or `kind` github), or `remove` one by `id`; the API's rules and errors, an admin-scope token; a secret is never read back, only `hasSecret`",
  description:
    "Your origin OAuth apps: list, add, remove.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string" },
      id: { type: "string" },
      host: { type: "string" },
      kind: { type: "string" },
      clientId: { type: "string" },
      clientSecret: { type: "string" },
    },
  },
  writes: true,
  async run(ctx, user, args) {
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "origin apps need an admin-scope token");
    const action = args["action"];
    // Never the secret: an app is shown as `hasSecret`, and errors are codes.
    const shown = (a: ReturnType<typeof listOriginApps>[number]) => {
      const { userId: _owner, ...rest } = a;
      return rest;
    };
    if (action === "list")
      return good({ items: listOriginApps(ctx.app, user).map(shown), next_cursor: null });
    if (action === "add") {
      const kind = str(args["kind"]);
      const clientId = str(args["clientId"]);
      if (kind !== "" && kind !== "github" && kind !== "forgejo" && kind !== "gitea")
        return bad("invalid", "kind is github, forgejo or gitea");
      if (clientId === "") return bad("invalid", "`clientId` is required");
      const host = str(args["host"]) || kind;
      if (host === "") return bad("invalid", "`host` or `kind` is required");
      const secret = args["clientSecret"];
      const saved = await registerOriginApp(ctx.app, user, {
        host,
        ...(kind === "" ? {} : { kind }),
        clientId,
        ...(typeof secret === "string" ? { clientSecret: secret } : {}),
      });
      return saved.ok ? good(shown(saved.value)) : bad(saved.error, connectMessage(saved.error));
    }
    if (action === "remove") {
      const id = str(args["id"]);
      if (id === "") return bad("invalid", "`id` is required");
      const removed = deleteOriginApp(ctx.app, user, id);
      return removed.ok ? good({}) : bad("not_found", "no such origin app");
    }
    return bad("invalid", "`action` is list, add or remove");
  },
};
