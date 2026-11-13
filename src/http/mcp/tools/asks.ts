import { applyAskFilter, ASK_FILTER_DOS, isAskFilterDo, type AskFilterChange } from "../../../actions/ask_filter.ts";
import { ASK_KINDS, HIDE_APP_DAY_WORDS, HIDE_KIND_WORDS, isAskKind, SHOW_ALL_WORDS } from "../../../core/ask_filters.ts";
import { asksAnswer } from "../../../web/studio/asks.ts";
import { good, bad, type Tool, CHIP_ARGS, chipArgs, APP_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "asks",
  description:
    "What waits on you, most important first; saved filter applies; `filter` sets or clears one",
  inputSchema: {
    type: "object",
    properties: {
      ...CHIP_ARGS,
      filter: { type: "string", enum: [...ASK_FILTER_DOS] },
      app: APP_ARG,
      kind: { type: "string", enum: [...ASK_KINDS] },
    },
  },
  doc:
    `\`{ hide_kinds?, hide_people?, filter?, app?, kind? }\`: what waits on you, most important first; your saved filter applies unless a chip argument overrides it. \`filter\` (\`hide_app_day\` is "${HIDE_APP_DAY_WORDS}", \`hide_app\`, \`show_app\` with \`app\`; \`hide_kind\` is "${HIDE_KIND_WORDS}", \`show_kind\` with \`kind\`; \`clear\` is "${SHOW_ALL_WORDS}") sets your ask filters, the same as the page and terminal: nothing hidden is lost, a hide for a day ends by itself, a security ask always shows; the answer says how many are hidden`,
  writes: true,
  readsWithout: "filter",
  run(ctx, user, args) {
    const chips = chipArgs(ctx, args);
    if (chips && "error" in chips) return bad("invalid", chips.error);
    const db = ctx.app.db;
    if (args["filter"] !== undefined) {
      const what = args["filter"];
      if (!isAskFilterDo(what)) return bad("invalid", `filter is ${ASK_FILTER_DOS.join(", ")}`);
      let change: AskFilterChange;
      if (what === "clear") change = { do: "clear" };
      else if (what === "hide_kind" || what === "show_kind") {
        if (!isAskKind(args["kind"])) return bad("invalid", `kind is ${ASK_KINDS.join(", ")}`);
        change = { do: what, kind: args["kind"] };
      } else {
        const repo = repoArg(ctx, user, { repo: args["app"] });
        if (isAnswer(repo)) return repo;
        change = { do: what, repo };
      }
      applyAskFilter(db, user, change);
    }
    return good(asksAnswer(ctx, user, chips));
  },
};
