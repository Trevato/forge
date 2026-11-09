import { ECONOMICS_WORDS, changeEconomics, readEconomics, type EconomicsError } from "../../../actions/economics.ts";
import { parseMarginPct, parsePosition, parseSlots, parseUsdCents } from "../../../core/slider.ts";
import { labelInput } from "../../../core/placement_policy.ts";
import { wire } from "../../api/economics.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

/** Every field the tool can set, as `PUT /api/v1/forge/economics` takes them. */
const FIELDS = ["position", "marginPct", "ownedNodeLabel", "ownedMonthUsd", "ownedSlots", "cloudHourUsd", "storageGbMonthUsd"] as const;
type Field = (typeof FIELDS)[number];

export const tool: Tool = {
  name: "economics",
  doc: "`{ position?, marginPct?, ownedNodeLabel?, ownedMonthUsd?, ownedSlots?, cloudHourUsd?, storageGbMonthUsd?, dryRun? }`: with nothing, the profit slider's `position` (0 to 100), `marginPct` (0 to 500), the `policy` and its `words`, `placement` (whether a cloud body takes bursts, the `ownedNodeLabel` that selects owned nodes), the operator's `prices` (US dollars) and this UTC `month`'s cost, as `GET /api/v1/forge/economics` answers; with any field, set it (prices in US dollars with at most two decimals, non-negative; `ownedSlots` a whole number of app-slots; a label as `key=value`, blank for the default `plat.sh/site=vxrail`) with an admin token, a forge admin who is a person, never an agent, planned first (`dryRun` is true unless `false`); anyone else is told `not_found`",
  description: "Read the profit slider, its policy, placement, the prices and the month's cost, or set them (admin).",
  inputSchema: {
    type: "object",
    properties: {
      position: { type: "integer" },
      marginPct: { type: "integer" },
      ownedNodeLabel: { type: "string" },
      ownedMonthUsd: { type: "number", minimum: 0 },
      ownedSlots: { type: "integer", minimum: 0 },
      cloudHourUsd: { type: "number", minimum: 0 },
      storageGbMonthUsd: { type: "number", minimum: 0 },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  readsWithout: [...FIELDS],
  run(ctx, user, args) {
    const given: Partial<Record<Field, unknown>> = {};
    for (const f of FIELDS) if (args[f] !== undefined) given[f] = args[f];
    const refuse = (error: EconomicsError) =>
      error === "not_found" ? bad("not_found", "Not found.") : bad("invalid", ECONOMICS_WORDS[error]);
    const read = readEconomics(ctx.app, user);
    if (!read.ok) return refuse(read.error);
    if (Object.keys(given).length === 0) return good(wire(read.value));
    if (args["dryRun"] !== false) {
      const invalid = checkOnly(given);
      if (invalid) return refuse(invalid);
      const before = wire(read.value);
      const now = (f: Field): unknown =>
        f === "position" || f === "marginPct"
          ? before[f]
          : f === "ownedNodeLabel"
            ? before.placement.ownedNodeLabel
            : before.prices[f];
      const from: Partial<Record<Field, unknown>> = {};
      const to: Partial<Record<Field, unknown>> = {};
      for (const f of FIELDS) {
        from[f] = now(f);
        to[f] = given[f] === undefined ? now(f) : f === "ownedNodeLabel" ? labelInput(given[f]) : Number(given[f]);
      }
      return good({ from, to, says: "This is the plan; nothing changed. Send dryRun: false to set it." });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "setting the slider needs an admin token");
    const changed = changeEconomics(ctx.app, user, given);
    return changed.ok ? good(wire(changed.value)) : refuse(changed.error);
  },
};

/** The write's own validation, without the write. */
function checkOnly(given: Partial<Record<Field, unknown>>): Exclude<EconomicsError, "not_found"> | undefined {
  if (given.position !== undefined && parsePosition(given.position) === undefined) return "bad_position";
  if (given.marginPct !== undefined && parseMarginPct(given.marginPct) === undefined) return "bad_margin";
  if (given.ownedNodeLabel !== undefined && labelInput(given.ownedNodeLabel) === undefined) return "bad_label";
  for (const f of ["ownedMonthUsd", "cloudHourUsd", "storageGbMonthUsd"] as const)
    if (given[f] !== undefined && parseUsdCents(given[f]) === undefined) return "bad_price";
  if (given.ownedSlots !== undefined && parseSlots(given.ownedSlots) === undefined) return "bad_slots";
  return undefined;
}
