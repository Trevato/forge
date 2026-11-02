import { turnValveFor } from "../../../actions/valves.ts";
import { readPipes } from "../../../flow/pipes.ts";
import { levelWords, parseLevel } from "../../../flow/valve.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "valves",
  doc: "`{ repo?, level?, dryRun? }` (a forge admin who is a person; an agent is told no such tool): the week's budget as pipes, the same page as /flow: `{ usd, shipped, sources, valves: [{ slug, level, mode, usd, runs, shipped, next: { queued, goes, yields, held }, turned?, suggestion? }] }`; with `repo` (`owner/name`) and `level` (0 shut, 1 to 99 the share of the week's starts, 100 open), planned first (`dryRun` is true unless `false`); applying needs an admin-scope token and takes effect on the next tick. A valve is the owner's alone, so no agent turns one; `suggestion` is where the owner looks, and moves nothing",
  description: "The week's pipes and valves; with `repo` and `level`, turns a valve (plans first).",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string", maxLength: 200 },
      level: { type: "integer", minimum: 0, maximum: 100 },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  run(ctx, user, args) {
    if (user?.isAdmin !== true || user.kind === "agent") return bad("not_found", "no such tool here");
    const pipes = readPipes(ctx.app.db, user.id);
    const repo = typeof args["repo"] === "string" ? args["repo"] : undefined;
    if (repo === undefined) return good(pipes);
    const level = parseLevel(args["level"]);
    if (level === undefined) return bad("invalid_level", "level is a whole number from 0 (shut) to 100 (open)");
    const now = pipes.valves.find((v) => v.slug === repo);
    if (args["dryRun"] !== false)
      return good({
        says: `Would set the valve of ${repo} from ${now?.level ?? 100} to ${level}. ${levelWords(level)} Send dryRun: false to turn it.`,
      });
    if (!scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "turning a valve needs an admin-scope token");
    const turned = turnValveFor(ctx.app, user, repo, level);
    if (!turned.ok) return bad(turned.error, turned.error === "not_found" ? "no such repository" : "level is a whole number from 0 to 100");
    return good(turned.value);
  },
};
