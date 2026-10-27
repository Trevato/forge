import { makeWinnerDefault } from "../../../actions/flag_winner.ts";
import { mayManageFlags } from "../../../core/flags.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "flag_winner",
  doc: "`{ name, winner }`: make an A/B flag's winning variant (`on` or `off`, only the one the read-out offers) its default for everyone, opening the clean-up issue first; a forge admin with an admin token; answers `{ name, winner, issue, says }`",
  description: "An A/B flag winner becomes default.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, winner: { enum: ["on", "off"] } },
    required: ["name", "winner"],
  },
  writes: true,
  run(ctx, user, args) {
    if (!mayManageFlags(user)) return bad("forbidden", "Flags are set by a forge admin.");
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "a flag's default needs an admin token");
    const { name, winner } = args;
    if (typeof name !== "string" || (winner !== "on" && winner !== "off"))
      return bad("invalid", "send a flag name and winner, on or off");
    const done = makeWinnerDefault(ctx.app, user, name, winner);
    if (!done.ok) return bad("refused", done.message);
    return good({
      name,
      winner,
      issue: done.issue.number,
      says: `${name} is ${winner} for everyone; issue #${done.issue.number} asks the crew to remove the other path.`,
    });
  },
};
