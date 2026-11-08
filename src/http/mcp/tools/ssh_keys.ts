import { addSshKey, deleteSshKey } from "../../../actions/users.ts";
import { listKeys, publicKey } from "../../../core/keys.ts";
import { good, bad, keyWords, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "ssh_keys",
  doc: "`{ action?, title?, key?, id? }`: list your own SSH keys (default), add one (`key` is an authorized_keys line, `title` optional) or remove one by `id`; the API's rules and errors, add and remove need an `rw` token",
  description: "Your SSH keys; add: key, remove: id.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "add", "remove"] },
      title: { type: "string" },
      key: { type: "string" },
      id: { type: "string" },
    },
  },
  writes: true,
  readsWhen: (args) => (args["action"] ?? "list") === "list",
  run(ctx, user, args) {
    const action = args["action"] ?? "list";
    if (action === "list") return good(listKeys(ctx.app.db, user.id).map(publicKey));
    if (action === "add") {
      if (typeof args["key"] !== "string")
        return bad("invalid_key", "key is an authorized_keys line");
      const title = typeof args["title"] === "string" ? args["title"] : "";
      const added = addSshKey(ctx.app, user, { name: title, key: args["key"] });
      return added.ok ? good(publicKey(added.value)) : bad(added.error, keyWords(added.error));
    }
    if (action === "remove") {
      const removed = deleteSshKey(ctx.app, user, typeof args["id"] === "string" ? args["id"] : "");
      return removed.ok ? good({ removed: args["id"] }) : bad(removed.error, keyWords(removed.error));
    }
    return bad("invalid_action", "action is list, add or remove");
  },
};
