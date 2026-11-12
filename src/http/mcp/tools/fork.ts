import { forkRepo, FORKS_PER_DAY, repositoryLimitMessage } from "../../../actions/repos.ts";
import { VERIFY_FIRST } from "../../../actions/verify_words.ts";
import { GUEST_REFUSALS, isGuestRefusal } from "../../../core/contribute.ts";
import { NOT_A_MEMBER } from "../../../core/roles.ts";
import { storageLimitMessage } from "../../../core/storage.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

/** The MCP door to `POST /api/v1/repos/:owner/:name/forks`: the same action, the same refusals. */
export const tool: Tool = {
  name: "fork",
  doc: "`{ repo, name? }`: fork a repository you can read into your account, as POST `/api/v1/repos/:owner/:name/forks` does. For a guest this is Help build this: a public fork that runs nothing, to change with `write_file` or git and send back with `open_pull`; a refusal says what to do instead",
  description: "Fork a repository into your account; for a guest, a copy to send changes back from.",
  inputSchema: {
    type: "object",
    properties: { repo: REPO_ARG, name: { type: "string" } },
    required: ["repo"],
  },
  writes: true,
  async run(ctx, user, args) {
    const parent = repoArg(ctx, user, args);
    if (isAnswer(parent)) return parent;
    const forked = await forkRepo(ctx.app, user, parent, str(args["name"]) || undefined);
    if (forked.ok)
      return good({
        says: `Forked to ${forked.value.ownerName}/${forked.value.name}. Commit to it, then send it back with open_pull.`,
        repo: `${forked.value.ownerName}/${forked.value.name}`,
      });
    const e = forked.error;
    if (isGuestRefusal(e)) return bad(e, GUEST_REFUSALS[e]);
    if (e === "unverified") return bad(e, VERIFY_FIRST);
    if (e === "not_member") return bad(e, NOT_A_MEMBER);
    if (e === "repository_limit") return bad(e, repositoryLimitMessage(ctx.app, user));
    if (e === "storage_limit") return bad(e, storageLimitMessage(ctx.app, user.id));
    if (e === "limit") return bad(e, `at most ${FORKS_PER_DAY} forks a day: try again tomorrow`);
    if (e === "already_forked") return bad(e, "you already have a fork of this repository: commit to it");
    if (e === "not_found") return bad(e, "no such repository");
    return bad(e, "the fork could not be made");
  },
};
