import { answerVision } from "../../../crew/vision.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "vision",
  doc: "`{ repo, number? }`: `{ purpose, order: [{ n, name, text }], rules, direction, directionStall, directionParts, preview, updatedAt }` from docs/VISION.md on the default branch; without the document `purpose` is null and `order` empty; `directionStall` (why a saved direction has no direction issue, else null; admins only), `direction` (the autonomy direction) and `directionParts` (it cut into `{ kind: vision|owner, text }`: the fenced block that follows docs/VISION.md, and the owner's words) only for those who may read the repository's settings, else null; with `number` (an open vision pull) those same people get `preview`: `{ today, after }`, the direction as it stands and as an admin's merge will write it, or `{ why }` it would stay; else null",
  description:
    "VISION.md: purpose, order, rules.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, number: { type: "integer", minimum: 1 } },
    required: ["repo"],
  },
  writes: false,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    return good(await answerVision(ctx.app, user, repo, typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined));
  },
};
