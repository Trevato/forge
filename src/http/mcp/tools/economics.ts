import { ECONOMICS_WORDS, changeEconomics, readEconomics, type EconomicsError } from "../../../actions/economics.ts";
import { parseMarginPct, parsePosition } from "../../../core/slider.ts";
import { labelInput } from "../../../core/placement_policy.ts";
import { wire } from "../../api/economics.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "economics",
  doc: "`{ position?, marginPct?, ownedNodeLabel?, dryRun? }`: with nothing, the profit slider's `position` (0 to 100), `marginPct` (0 to 500), the `policy` and its `words`, and `placement` (whether a cloud body takes bursts, the `ownedNodeLabel` that selects owned nodes), as `GET /api/v1/forge/economics` answers; with either number or a label (`key=value`, blank for the default `plat.sh/site=vxrail`), set it (an admin token; a forge admin who is a person, never an agent), planned first (`dryRun` is true unless `false`); anyone else is told `not_found`",
  description: "Read the profit slider and its policy, or set it (admin).",
  inputSchema: {
    type: "object",
    properties: {
      position: { type: "integer" },
      marginPct: { type: "integer" },
      ownedNodeLabel: { type: "string" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  readsWithout: ["position", "marginPct", "ownedNodeLabel"],
  run(ctx, user, args) {
    const { position, marginPct, ownedNodeLabel } = args;
    const refuse = (error: EconomicsError) =>
      error === "not_found" ? bad("not_found", "Not found.") : bad("invalid", ECONOMICS_WORDS[error]);
    const read = readEconomics(ctx.app, user);
    if (!read.ok) return refuse(read.error);
    if (position === undefined && marginPct === undefined && ownedNodeLabel === undefined) return good(wire(read.value));
    if (args["dryRun"] !== false) {
      const before = read.value;
      const invalid = checkOnly(position, marginPct, ownedNodeLabel);
      if (invalid) return refuse(invalid);
      const to = {
        position: position === undefined ? before.position : position,
        marginPct: marginPct === undefined ? before.marginPct : marginPct,
        ownedNodeLabel: ownedNodeLabel === undefined ? before.placement.ownedNodeLabel : labelInput(ownedNodeLabel),
      };
      return good({
        from: { position: before.position, marginPct: before.marginPct, ownedNodeLabel: before.placement.ownedNodeLabel },
        to,
        says: "This is the plan; nothing changed. Send dryRun: false to set it.",
      });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "setting the slider needs an admin token");
    const changed = changeEconomics(ctx.app, user, { position, marginPct, ownedNodeLabel });
    return changed.ok ? good(wire(changed.value)) : refuse(changed.error);
  },
};

/** The write's own validation, without the write. */
function checkOnly(position: unknown, marginPct: unknown, label: unknown): "bad_position" | "bad_margin" | "bad_label" | undefined {
  if (position !== undefined && parsePosition(position) === undefined) return "bad_position";
  if (marginPct !== undefined && parseMarginPct(marginPct) === undefined) return "bad_margin";
  if (label !== undefined && labelInput(label) === undefined) return "bad_label";
  return undefined;
}
