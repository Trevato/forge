import { changeLimit, listLimits } from "../../../actions/limits.ts";
import { changePlans, readPlans } from "../../../actions/plans.ts";
import { MAX_PLANS, parsePlans } from "../../../settings/plans.ts";
import { LIMIT_KEYS } from "../../../settings/limits.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "limits",
  doc: "`{ key?, value?, plans?, dryRun? }` (forge admin): every limit the forge's owner can hit, with its value, default and bounds; with `key` and `value` (`\"\"` restores the default), planned first (`dryRun` is true unless `false`); a value out of bounds is refused, applying needs an admin-scope token; the answer lists the plans; `plans`, a list of `{ key, name, says, size, priceUsd, creditUsd, forges }`, replaces them",
  description:
    "Every limit the owner can hit. `key`+`value` (\"\" restores) plans.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", enum: [...LIMIT_KEYS] },
      value: { type: "string", maxLength: 16 },
      plans: { type: "array", maxItems: MAX_PLANS, items: { type: "object" } },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const listed = listLimits(ctx.app, user);
    if (!listed.ok) return bad("not_found", "no such tool here");
    if (args["plans"] !== undefined) {
      if (args["dryRun"] !== false) {
        const parsed = parsePlans(args["plans"]);
        return parsed.ok
          ? good({ says: "Would replace the plans. Send dryRun: false to change them.", plans: parsed.value })
          : bad("invalid_plans", parsed.error);
      }
      if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "changing the plans needs an admin-scope token");
      const set = changePlans(ctx.app, user, args["plans"]);
      return set.ok ? good({ says: "Plans saved; the next spawn uses them.", plans: set.value }) : bad("invalid_plans", set.error === "not_found" ? "no such tool here" : set.error.invalid);
    }
    const key = typeof args["key"] === "string" ? args["key"] : undefined;
    if (key === undefined) return good({ ...listed.value, plans: readPlans(ctx.app) });
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
