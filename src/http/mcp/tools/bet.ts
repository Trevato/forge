import { backBet, endBet, giveVerdict, proposeBets, stopBet, writeLeft } from "../../../actions/bets.ts";
import { canAdmin } from "../../../core/repos.ts";
import { scopeAllows } from "../../../core/tokens.ts";
import { good, bad, type Tool, str, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "bet",
  doc: "`{ app, verb, bet?, share?, line?, verdict?, why? }`: `propose` has the planner propose bets from open work; the owner `back`s one with a `share` of the week (at most 5 run), `stop`s, `cut`s or `end`s it, and gives a `verdict` (done, or not_yet with `why`) on a finished one; the lead writes what is `left` in one `line`. Needs a write token",
  description: "Propose, back, stop, cut or end a bet; write what is left; say whether it feels done.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      verb: { type: "string", enum: ["propose", "back", "stop", "cut", "end", "left", "verdict"] },
      bet: { type: "string", maxLength: 64 },
      share: { type: "integer", minimum: 1, maximum: 100 },
      line: { type: "string", maxLength: 240 },
      verdict: { type: "string", enum: ["done", "not_yet"] },
      why: { type: "string", maxLength: 240 },
    },
    required: ["app", "verb"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (!scopeAllows(ctx.auth.scope ?? "ro", "rw")) return bad("forbidden", "this needs a write token");
    const verb = str(args["verb"]);
    const id = str(args["bet"]);
    if (verb === "propose") {
      if (user.kind === "agent" || !canAdmin(ctx.app.db, repo, user)) return bad("forbidden", "only the owner asks for proposals");
      const made = proposeBets(ctx.app, repo);
      return good({ says: `${made.length} proposed.`, items: made.map((b) => ({ id: b.id, name: b.name })) });
    }
    const verdict = str(args["verdict"]);
    const done =
      verb === "back" ? backBet(ctx.app, user, repo, id, Number(args["share"]))
      : verb === "stop" ? stopBet(ctx.app, user, repo, id)
      : verb === "cut" ? endBet(ctx.app, user, repo, id, "cut")
      : verb === "end" ? endBet(ctx.app, user, repo, id, "done")
      : verb === "left" ? writeLeft(ctx.app, user, repo, id, str(args["line"]))
      : verb === "verdict" && (verdict === "done" || verdict === "not_yet") ? giveVerdict(ctx.app, user, repo, id, verdict, str(args["why"]))
      : undefined;
    if (done === undefined) return bad("bad_verb", "verb is propose, back, stop, cut, end, left or verdict");
    if (!done.ok) return bad(done.error.error, done.error.message);
    return good({ says: `${done.value.name}: ${done.value.state}.`, state: done.value.state });
  },
};
