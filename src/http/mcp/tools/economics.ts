import { ECONOMICS_WORDS, changeEconomics, readEconomics } from "../../../actions/economics.ts";
import { parseMarginPct, parsePosition } from "../../../core/slider.ts";
import { wire } from "../../api/economics.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "economics",
  doc: "`{ position?, marginPct?, dryRun? }`: with nothing, the profit slider's `position` (0 to 100), `marginPct` (0 to 500), the `policy` and its `words`, as `GET /api/v1/forge/economics` answers; with either number, set it (an admin token; a forge admin who is a person, never an agent), planned first (`dryRun` is true unless `false`); anyone else is told `not_found`",
  description: "Read the profit slider and its policy, or set it (admin).",
  inputSchema: {
    type: "object",
    properties: {
      position: { type: "integer" },
      marginPct: { type: "integer" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  readsWithout: ["position", "marginPct"],
  run(ctx, user, args) {
    const { position, marginPct } = args;
    const refuse = (error: "not_found" | "bad_position" | "bad_margin") =>
      error === "not_found" ? bad("not_found", "Not found.") : bad("invalid", ECONOMICS_WORDS[error]);
    const read = readEconomics(ctx.app, user);
    if (!read.ok) return refuse(read.error);
    if (position === undefined && marginPct === undefined) return good(wire(read.value));
    if (args["dryRun"] !== false) {
      const before = read.value;
      const invalid = checkOnly(position, marginPct);
      if (invalid) return refuse(invalid);
      const to = {
        position: position === undefined ? before.position : position,
        marginPct: marginPct === undefined ? before.marginPct : marginPct,
      };
      return good({
        from: { position: before.position, marginPct: before.marginPct },
        to,
        says: "This is the plan; nothing changed. Send dryRun: false to set it.",
      });
    }
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "setting the slider needs an admin token");
    const changed = changeEconomics(ctx.app, user, { position, marginPct });
    return changed.ok ? good(wire(changed.value)) : refuse(changed.error);
  },
};

/** The write's own validation, without the write. */
function checkOnly(position: unknown, marginPct: unknown): "bad_position" | "bad_margin" | undefined {
  if (position !== undefined && parsePosition(position) === undefined) return "bad_position";
  if (marginPct !== undefined && parseMarginPct(marginPct) === undefined) return "bad_margin";
  return undefined;
}
