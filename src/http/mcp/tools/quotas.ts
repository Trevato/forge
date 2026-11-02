import { changeQuotas, readQuotas } from "../../../actions/quotas.ts";
import { QUOTA_KEYS } from "../../../settings/quotas.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "quotas",
  doc: "`{ key?, value?, dryRun? }` (forge admin): the per-account quotas `repositories`, `apps`, `storage` (MB), `previews`, `runs`, `checks`, each a number or null for none. `repositories` bounds repos on create, fork and copy; `apps` the apps made; `storage` the MB of repos plus app data, asked on push, create and fork; `previews` live previews; `runs` concurrent agent runs; `checks` concurrent checks. Each is asked before the thing is made or started and a forge admin is never limited; with `key` and `value` (`\"\"` clears), planned first (`dryRun` is true unless `false`); applying needs an admin-scope token",
  description:
    "Enforced per-account quotas (never an admin): repositories, apps, storage, previews, runs, checks. key+value plans.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", enum: [...QUOTA_KEYS] },
      value: { type: "string", maxLength: 16 },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const read = readQuotas(ctx.app, user);
    if (!read.ok) return bad("not_found", "no such tool here");
    const key = typeof args["key"] === "string" ? args["key"] : undefined;
    if (key === undefined) return good(read.value);
    const value = typeof args["value"] === "string" ? args["value"] : "";
    if (!(QUOTA_KEYS as readonly string[]).includes(key))
      return bad("no_such_quota", `no quota ${key}`);
    const now = read.value.quotas[key as (typeof QUOTA_KEYS)[number]];
    if (args["dryRun"] !== false)
      return good({
        says: `Would set ${key} from ${now ?? "no limit"} to ${value || "no limit"}. Send dryRun: false to change it.`,
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the forge's quotas needs an admin-scope token");
    const changed = changeQuotas(ctx.app, user, { [key]: value });
    if (!changed.ok)
      return bad(changed.error, "a quota is a positive whole number, or empty for no limit");
    return good({
      says: `${key}: ${now ?? "no limit"} → ${changed.value[key as (typeof QUOTA_KEYS)[number]] ?? "no limit"}.`,
      quotas: changed.value,
    });
  },
};
