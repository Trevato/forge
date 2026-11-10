import { setKnob } from "../../../actions/knobs.ts";
import { knobLines, readKnobs } from "../../../crew/knobs.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "knobs",
  doc: "`{ knob?, value?, repo?, dryRun? }` (forge admin): the crew's five knobs in the page's words, each with its live effect: `speed` (runs at once, 1-16), `budget` (percent of the week to use, 10-100), `polish` (percent share, 0-50), `autonomy` (`off`, `ask` or `go`, with `repo` as `owner/name`), and `feedback` (always on). With `knob` and `value`, planned first (`dryRun` is true unless `false`); applying needs an admin-scope token",
  description: "The crew's five knobs and what each does now. With `knob` and `value`, plans.",
  inputSchema: {
    type: "object",
    properties: {
      knob: { type: "string", enum: ["speed", "budget", "polish", "autonomy"] },
      value: { type: "string", maxLength: 16 },
      repo: { type: "string", maxLength: 100 },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (user?.isAdmin !== true || user.kind === "agent") return bad("not_found", "no such tool here");
    const knob = typeof args["knob"] === "string" ? args["knob"] : undefined;
    if (knob === undefined) {
      const rows = readKnobs(ctx.app);
      return good({ knobs: rows, says: knobLines(rows) });
    }
    const value = typeof args["value"] === "string" ? args["value"] : "";
    const repo = typeof args["repo"] === "string" ? args["repo"] : undefined;
    if (args["dryRun"] !== false)
      return good({ says: `Would set ${knob}${repo === undefined ? "" : ` for ${repo}`} to ${value}. Send dryRun: false to change it.` });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin")) return bad("forbidden", "turning a knob needs an admin-scope token");
    const set = await setKnob(ctx.app, user, knob, value, repo);
    if (!set.ok) return bad(set.error, "That knob or value is not one the knobs take.");
    return good({ says: `${knob}: ${set.value.value}, from the next pump on.`, ...set.value });
  },
};
