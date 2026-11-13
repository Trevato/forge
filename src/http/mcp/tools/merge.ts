import { mayView } from "../../../core/sealed.ts";
import { mergePull } from "../../../actions/pulls.ts";
import { getPull, pullDir, pullMergeState } from "../../../core/pulls.ts";
import { checkSummary } from "../../../core/runs.ts";
import { mergeFailure } from "../../../web/pages/pull.ts";
import { LAND_AS_IS, stalledWords } from "../../../web/studio/land_as_is.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

/**
 * The pull page's Merge button from any MCP client: a second door to
 * `mergePull`, never a looser one. Rule 1 in docs/APPS.md — the crew
 * proposes, a person lands — is said here before anything is read, and
 * `mergePull` says it again.
 */
export const tool: Tool = {
  name: "merge",
  doc: "`{ repo, number, strategy?, action?, dryRun? }` (a person, never an agent: a person merges): land a pull as its page's Merge button does, `merge` (default) or `squash`; `action: \"land\"` is the page's Land it as it is (squash, and only while the check is green); plans carry `crew` when the crew cannot go on; planned unless `dryRun` is false: the plan is the pull's `head`, `base`, `mergeable`, `conflicts` and `check` as `pull` reads them; landing is `mergePull`'s, with its refusals (conflict, review or check required, not a writer) in the page's words, and takes an rw token",
  description: "Land a pull, as its page's Merge button does; a person's only.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      strategy: { type: "string", enum: ["merge", "squash"] },
      action: { type: "string", enum: ["land"] },
      dryRun: { type: "boolean" },
    },
    required: ["repo", "number"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (user.kind === "agent")
      return bad("forbidden", "the crew proposes and a person merges; an agent may not land a pull");
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const s = args["strategy"];
    if (s !== undefined && s !== "merge" && s !== "squash")
      return bad("invalid", "strategy is merge or squash");
    const act = args["action"];
    if (act !== undefined && act !== "land") return bad("invalid", "action is land");
    const strategy = s === "squash" || act === "land" ? "squash" : "merge";
    const n = args["number"];
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
      return bad("no_such_pull", `no pull #${String(n)}`);
    const stalled = stalledWords(ctx.app);
    const url = `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`;
    if (args["dryRun"] !== false) {
      // The `pull` tool's reads, so the plan and the reading never disagree.
      const dir = await pullDir(ctx.app.db, ctx.app.reposRoot, repo, pull);
      const state = await pullMergeState(dir, pull);
      const check = checkSummary(ctx.app.db, pull.id, pull.headOid);
      return good({
        dryRun: true,
        number: pull.number,
        state: pull.mergedAt !== null ? "merged" : pull.state,
        head: pull.headBranch,
        base: pull.baseBranch,
        strategy,
        mergeable: state?.mergeable ?? false,
        conflicts: state?.conflicts ?? [],
        check: { state: check.state, baseOid: check.run?.baseOid ?? "" },
        url,
        ...(stalled === null ? {} : { crew: stalled }),
        says: "This is the plan; nothing changed. Send dryRun: false to merge.",
      });
    }
    if (act === "land" && checkSummary(ctx.app.db, pull.id, pull.headOid).state !== "ok")
      return bad("check_required", `${LAND_AS_IS} waits for a green check`);
    const merged = await mergePull(ctx.app, user, repo, pull, strategy);
    if (!merged.ok) {
      const error = merged.error;
      const code =
        typeof error !== "string"
          ? error.kind
          : error === "unauthorized"
            ? "forbidden"
            : error;
      return bad(code, mergeFailure(error));
    }
    return good({
      dryRun: false,
      merged: true,
      strategy,
      mergeOid: merged.value.mergeOid,
      url,
      says: act === "land" ? `Landed #${pull.number} as it is.` : `Merged #${pull.number} into ${pull.baseBranch}.`,
    });
  },
};
