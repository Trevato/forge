import { STEER_SAYS, steerRepoRun } from "../../../actions/runs.ts";
import { steerRefusedWords } from "../../../actions/steer_words.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "steer",
  doc: "`{ repo, run, text }`: say a word to one running crew run by its id, as the run page's steer box and `POST …/runs/:id/steer` do; a writer's (never an agent), the run an agent's, `text` not empty; answers `{ says, outcome }` (`sent` or `commented`)",
  description: "Say a word to one crew run by its id.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, run: { type: "string" }, text: { type: "string" } },
    required: ["repo", "run", "text"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const steered = steerRepoRun(ctx.app, user, repo, str(args["run"]), str(args["text"]));
    if (!steered.ok) return bad(steered.error, steerRefusedWords(steered.error));
    return good({
      says: STEER_SAYS[steered.value],
      outcome: steered.value,
    });
  },
};
