import { doctorRuns } from "../../../checks/doctor.ts";
import { recentGates } from "../../../checks/gate_result.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "queue_gates",
  doc: "`{ repo, limit? }`: the merge queue's recent gates, newest first (`limit` 1–100, default 20), as `GET …/queue/gates` answers: each gate's pulls, state, reason, counts and failing tests by name with their first error lines, a test red in two gates that share no pull flagged `flaky`; `doctor`: the batch doctor's last acts on the repository (`culprit`, `class`, `action` held/recheck/kept, `probe`; a sealed pull's `culprit` is null and its `batch` and `probe` blank)",
  description: "Recent merge-queue gates: pulls, verdicts, failing tests.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["repo"],
  },
  writes: false,
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const limit = args["limit"] ?? 20;
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100)
      return bad("invalid", "`limit` is a whole number from 1 to 100");
    const gates = recentGates(ctx.app.db, repo.id, limit);
    const red = gates.filter((g) => g.state === "red").length;
    return good({ says: `${gates.length} gate(s), ${red} red.`, gates, doctor: doctorRuns(ctx.app.db, repo.id, limit) });
  },
};
