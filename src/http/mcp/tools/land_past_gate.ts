import { mayView } from "../../../core/sealed.ts";
import { landPastGate, planBypass, type BypassError } from "../../../checks/bypass.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

/**
 * The owner's break-glass (#7790) from any MCP client: the pull page's
 * "Land past the gate", in the same words. A person who administers the
 * repository, never an agent; the reason lands on the pull's trail.
 */
export const tool: Tool = {
  name: "land_past_gate",
  doc: "`{ repo, number, reason, dryRun? }` (an owner, never an agent): land one named pull past the checks when landing has stopped (the forge's own repository, three red gates of one cause); `reason` (8 to 500 characters) is recorded on the pull's trail and the outbox as `pull.bypassed`; planned unless `dryRun` is false; takes an rw token",
  description: "Land one pull past a broken gate, with a recorded reason; an owner's only.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 8, maxLength: 500 },
      dryRun: { type: "boolean" },
    },
    required: ["repo", "number", "reason"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (user.kind === "agent") return bad("forbidden", "the crew proposes and an owner lands; an agent may not bypass the gate");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    const pull = typeof n === "number" && Number.isInteger(n) && n > 0 ? getPull(ctx.app.db, repo.id, n) : undefined;
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user)) return bad("no_such_pull", `no pull #${String(n)}`);
    const reason = typeof args["reason"] === "string" ? args["reason"] : "";
    const refused = planBypass(ctx.app, user, repo, pull, reason);
    if (refused !== undefined) return refusal(refused);
    if (args["dryRun"] !== false)
      return good({ dryRun: true, number: pull.number, reason, says: "This is the plan; nothing changed. Send dryRun: false to land past the gate." });
    const landed = await landPastGate(ctx.app, user, repo, pull, reason);
    if (!landed.ok) return refusal(landed.error);
    return good({ dryRun: false, landed: true, mergeOid: landed.value.mergeOid, says: `Landed #${pull.number} past the gate; the reason is on its trail.` });
  },
};

function refusal(e: BypassError): ReturnType<typeof bad> {
  switch (e.kind) {
    case "reason":
      return bad("reason", "the reason must be 8 to 500 characters");
    case "not_stopped":
      return bad("not_stopped", "landing has not stopped; wait for the checks, there is no way past the gate");
    case "merge":
      return bad("refused", `the merge was refused: ${typeof e.error === "string" ? e.error : e.error.kind}`);
    case "not_found":
      return bad("no_such_pull", "no such pull");
    default:
      return bad("forbidden", "only an owner may land a pull past the gate");
  }
}
