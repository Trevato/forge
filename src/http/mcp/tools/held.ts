import { applyGateReview, reviewGate } from "../../../actions/gate_review.ts";
import { THREAD_SAYS } from "../../../actions/thread_words.ts";
import { good, bad, type Tool, APP_ARG, planRepo, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "held",
  doc: "`{ app, apply? }`: what the Later gate holds, grouped by theme, with each as a candidate to close, from titles alone; `apply: [numbers], digest` (a person's token; the numbers to close, and the `digest` the read gave) does it, refused if what the gate holds has moved; only `done` ones are in `approve`; `lift` revives a closed one",
  description: "What the Later gate holds, and one proposed pass over it.",
  inputSchema: {
    type: "object",
    properties: {
      app: APP_ARG,
      apply: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 1000 },
      digest: { type: "string", maxLength: 64 },
    },
    required: ["app"],
  },
  writes: true,
  run(ctx, user, args) {
    const repo = planRepo(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const apply = args["apply"];
    if (apply !== undefined) {
      if (!Array.isArray(apply) || !apply.every((n) => Number.isInteger(n) && n > 0))
        return bad("invalid_apply", "apply is the list of issue numbers the proposal names");
      const done = applyGateReview(ctx.app, user, repo, apply as number[], typeof args["digest"] === "string" ? args["digest"] : undefined);
      if (!done.ok)
        return bad(
          done.error,
          done.error === "stale"
            ? "what the gate holds changed since you read it; read it again"
            : done.error === "forbidden"
              ? THREAD_SAYS.planForbidden
              : "there is no Later gate here",
        );
      return good({ says: `Closed ${done.value}.` });
    }
    const review = reviewGate(ctx.app, repo);
    if (review === undefined) return bad("not_found", "there is no Later gate here");
    return good({
      says: `${review.held} held; ${review.ticked.length} found done on main.`,
      themes: review.themes.map((t) => ({
        theme: t.name,
        issues: t.items.map((i) => ({ number: i.number, title: i.title, waiting: i.waiting, ...i.verdict })),
      })),
      approve: review.ticked,
      digest: review.digest,
    });
  },
};
