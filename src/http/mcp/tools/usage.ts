import { readForgeUsage, readUsage, usageDays, USAGE_DAYS_DEFAULT, USAGE_DAYS_MAX } from "../../../actions/usage.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "usage",
  doc: "`{ repo?, days? }`: no repo, the forge's spend today and last24h and each account's headroom %; else what the crew's runs spent — tokens, cost, wall time — by subscription, agent, issue, and each account's 5-hour and weekly standing; a writer's",
  description:
    "Crew spend: with `repo`, `days` (1–90) by agent, issue; without, today, last24h, headroom %. Writers.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      days: { type: "integer", minimum: 1, maximum: USAGE_DAYS_MAX },
    },
  },
  writes: false,
  run(ctx, user, args) {
    if (args["repo"] === undefined) {
      if (args["days"] !== undefined)
        return bad("invalid_days", "days needs a repo; without one the answer is today and last24h");
      return good(readForgeUsage(ctx.app, user));
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const raw = args["days"];
    const days =
      raw === undefined
        ? USAGE_DAYS_DEFAULT
        : typeof raw === "number"
          ? usageDays(String(raw))
          : undefined;
    if (days === undefined)
      return bad("invalid_days", `days is a whole number from 1 to ${USAGE_DAYS_MAX}`);
    const report = readUsage(ctx.app, user, repo, days);
    return report.ok
      ? good(report.value)
      : bad("forbidden", "spend is for those who can write this app");
  },
};
