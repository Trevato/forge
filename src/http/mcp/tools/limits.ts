import { changeLimit, listLimits } from "../../../actions/limits.ts";
import { LIMIT_KEYS } from "../../../settings/limits.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "limits",
  description:
    "Every limit the forge's owner can hit, value and bounds. `key` and `value` (\"\" restores) plan.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", enum: [...LIMIT_KEYS] },
      value: { type: "string", maxLength: 16 },
      dryRun: { type: "boolean", description: "false to apply" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const listed = listLimits(ctx.app, user);
    if (!listed.ok) return bad("not_found", "no such tool here");
    const key = typeof args["key"] === "string" ? args["key"] : undefined;
    if (key === undefined) return good(listed.value);
    const value = typeof args["value"] === "string" ? args["value"] : "";
    const now = listed.value.limits.find((l) => l.key === key);
    if (now === undefined) return bad("no_such_limit", `no limit ${key}`);
    if (args["dryRun"] !== false)
      return good({
        says: `Would set ${key} from ${now.value} to ${value || `its default, ${now.defaultValue}`}. Send dryRun: false to change it.`,
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the forge's limits needs an admin-scope token");
    const changed = changeLimit(ctx.app, user, key, value === "" ? null : value);
    if (!changed.ok) return bad(changed.error.kind, changed.error.kind === "out_of_bounds" ? changed.error.message : "no such limit");
    return good({
      says: `${key}: ${changed.value.from} → ${changed.value.to}, from the next use on.`,
      ...changed.value,
    });
  },
};
