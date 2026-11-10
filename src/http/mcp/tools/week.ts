import { takeProposal } from "../../../actions/week.ts";
import { polishSpend, polishWords } from "../../../crew/polish_share.ts";
import { latestRetro, takenOf } from "../../../flow/retro.ts";
import { bad, good, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "week",
  doc: "an app's last weekly retrospective, the same page as /:owner/:name/week (`app`): `{ polish: { share, percent, polishUsd, totalUsd, under }, weekEnd, shipped, projected, accuracy, costly, stuck, proposals: [{ number, words, taken }] }`; with `take` (a proposal's index, 0 to 2) a writer who is a person (never an agent) takes that one proposal, which puts its issue behind the Later gate; nothing else ever changes",
  description: "The week's retrospective; `take` accepts one proposal.",
  inputSchema: {
    type: "object",
    properties: { app: APP_ARG, take: { type: "integer", minimum: 0, maximum: 2 } },
    required: ["app"],
  },
  writes: true,
  readsWithout: "take",
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const retro = latestRetro(ctx.app.db, repo.id);
    const spend = polishSpend(ctx.app.db, repo.id, repo.polishShare, new Date());
    const polish = { share: spend.share, percent: Math.round(spend.percent * 10) / 10, polishUsd: spend.polishUsd, totalUsd: spend.totalUsd, under: spend.under, says: polishWords(spend) };
    if (retro === undefined) return good({ polish, says: "No weekly window has closed yet." });
    if (args["take"] !== undefined) {
      const idx = args["take"];
      if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > 2) return bad("invalid_take", "take is a proposal's index, 0 to 2");
      const took = takeProposal(ctx.app, user, repo, retro.weekEnd, idx);
      if (!took.ok) return bad(took.error.kind === "not_found" ? "no_such_proposal" : took.error.kind, took.error.message);
    }
    const taken = takenOf(ctx.app.db, repo.id, retro.weekEnd);
    return good({ ...retro, polish, proposals: retro.proposals.map((p, i) => ({ number: p.number, words: p.words, taken: taken.has(i) })) });
  },
};
