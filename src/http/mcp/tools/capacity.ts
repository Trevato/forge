import { DERIVED_WORDS, REASON_WORDS, SETTABLE_CAPACITY, changeCapacity, listCapacity } from "../../../actions/capacity.ts";
import { SETTING_WORDS } from "../../../actions/setting_words.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "capacity",
  doc: "`{ key?, value?, reason?, dryRun? }` (forge admin): the forge's capacity and guards, live (crew and checks concurrency, check shards, cell egress, the new-account guard, the sign-in edge, queue depth, child forges, `egress.npmBytesLastHour` and `npmTopRepoLastHour`, and `selfSwap: { enabled, migrateReq, blocked }`: whether `FORGE_SELF_SWAP=1`, the kernel's `tcp_migrate_req` (`1`, `0`, `unreadable`), and why this forge cannot swap itself, null when it can; only the first six are settable by `key`); with `key` and `value` (`\"\"` restores the default) and `reason` (kept with who; required for `cells.egress`), planned first (`dryRun` is true unless `false`); applying needs an admin-scope token",
  description:
    "Forge capacity and guards, live. With `key` and `value` (\"\" restores default), plans.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        enum: [...SETTABLE_CAPACITY],
      },
      value: { type: "string", maxLength: 16 },
      reason: { type: "string", maxLength: 500 },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    const listed = listCapacity(ctx.app, user);
    if (!listed.ok) return bad("not_found", "no such tool here");
    const key = typeof args["key"] === "string" ? args["key"] : undefined;
    if (key === undefined) return good(listed.value);
    const value = typeof args["value"] === "string" ? args["value"] : "";
    const now = listed.value.settings.find((s) => s.key === key);
    if (now === undefined) return bad("no_such_setting", `no capacity setting ${key}`);
    if (args["dryRun"] !== false)
      return good({
        says: `Would set ${key} from ${now.value || "auto"} to ${value || "its default"}. Send dryRun: false to change it.`,
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "changing the forge's capacity needs an admin-scope token");
    const reason = typeof args["reason"] === "string" ? args["reason"] : "";
    const changed = changeCapacity(ctx.app, user, key, value, reason);
    if (!changed.ok)
      return bad(
        changed.error,
        changed.error === "derived" ? DERIVED_WORDS : changed.error === "reason_required" ? REASON_WORDS : SETTING_WORDS.outOfRange,
      );
    return good({
      says: `${key}: ${changed.value.from || "auto"} → ${changed.value.to || "auto"}, from the next pick on.`,
      ...changed.value,
    });
  },
};
