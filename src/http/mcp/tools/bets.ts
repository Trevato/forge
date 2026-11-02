import { listBets, betScopes } from "../../../core/bets.ts";
import { canAdmin } from "../../../core/repos.ts";
import { scopeState } from "../../../crew/bets.ts";
import { good, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "bets",
  doc: "`{ app }`: the app's bets — each a name, a share of the week, what done looks like, its state (proposed, running, stopped, finished, cut), who backed it, what is left, and its scopes as figuring out, executing, raised hand or done",
  description: "A repository's bets and their scopes.",
  inputSchema: { type: "object", properties: { app: APP_ARG }, required: ["app"] },
  writes: false,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const now = new Date();
    // The plan is for those who administer; a reader gets names, states and scopes.
    const plan = user.kind !== "agent" && canAdmin(ctx.app.db, repo, user);
    return good({
      items: listBets(ctx.app.db, repo.id).map((b) => !plan ? ({
        id: b.id, name: b.name, state: b.state,
        scopes: betScopes(ctx.app.db, b.id).map((s) => ({ issue: s.number, title: s.title, state: scopeState(s, now) })),
      }) : ({
        id: b.id, name: b.name, share: b.appetite, state: b.state, backedBy: b.backedBy, journeys: b.journeys.split("\n").filter((j) => j !== ""),
        left: b.leftLine, verdict: b.verdict,
        scopes: betScopes(ctx.app.db, b.id).map((s) => ({ issue: s.number, title: s.title, state: scopeState(s, now) })),
      })),
    });
  },
};
