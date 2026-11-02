import { readUsage, usageDays, USAGE_DAYS_DEFAULT, USAGE_DAYS_MAX } from "../../../actions/usage.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "usage",
  doc: "`{ repo, days? }`: what the crew's runs spent — tokens, cost, wall time — by subscription, agent, issue, and each account's 5-hour and weekly standing; a writer's",
  description:
    "What crew runs on an app spent in `days` (1–90, default 7), by agent, issue. Writers.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      days: { type: "integer", minimum: 1, maximum: USAGE_DAYS_MAX },
    },
    required: ["repo"],
  },
  writes: false,
  run(ctx, user, args) {
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
