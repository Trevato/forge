import { openPull } from "../../../actions/pulls.ts";
import { VERIFY_FIRST } from "../../../actions/verify_words.ts";
import { GUEST_REFUSALS, isGuestRefusal } from "../../../core/contribute.ts";
import { getRepo } from "../../../core/repos.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

/** The MCP door to `POST /api/v1/repos/:owner/:name/pulls`: the same action, the same refusals. */
export const tool: Tool = {
  name: "open_pull",
  doc: "`{ repo, title, head, base?, body?, headRepo? }`: open a pull into `repo` from branch `head`, of `headRepo` (`owner/name`, a fork of `repo`) when given, as POST `/api/v1/repos/:owner/:name/pulls` does. A guest sends only from their own fork, and the pull runs nothing until a person approves it",
  description: "Open a pull request, from a branch or from your fork.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      title: { type: "string" },
      head: { type: "string" },
      base: { type: "string" },
      body: { type: "string" },
      headRepo: { type: "string" },
    },
    required: ["repo", "title", "head"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const headSpec = str(args["headRepo"]);
    const [owner, name, ...rest] = headSpec.split("/");
    const headRepo = headSpec === "" ? undefined : owner && name && rest.length === 0 ? getRepo(ctx.app.db, owner, name) : undefined;
    if (headSpec !== "" && headRepo === undefined) return bad("not_found", "no such head repository: give it as owner/name");
    const opened = await openPull(ctx.app, user, repo, {
      title: str(args["title"]),
      body: str(args["body"]),
      baseBranch: str(args["base"]) || repo.defaultBranch,
      headBranch: str(args["head"]),
      ...(headRepo === undefined ? {} : { headRepo }),
    });
    if (opened.ok)
      return good({
        says: `Opened #${opened.value.number}. A person reviews it; nothing in it runs until they approve.`,
        number: opened.value.number,
      });
    const e = opened.error;
    if (isGuestRefusal(e)) return bad(e, GUEST_REFUSALS[e]);
    if (e === "unverified") return bad(e, VERIFY_FIRST);
    return bad(e, e.replace(/_/g, " "));
  },
};
