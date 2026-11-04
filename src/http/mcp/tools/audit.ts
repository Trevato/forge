import { audit } from "../../../contract/audit.ts";
import { appsOf } from "../../../web/studio/asks.ts";
import { good, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "audit",
  doc: "`{ repo? }`: who can do what, per app (all you can see without `repo`), read from its contract.json in git: yes, own or no per door, and whether outsiders may direct its crew (`crewOutsiders`)",
  description:
    "Who can do what per app: resource × verb, yes, own or no.",
  inputSchema: {
    type: "object",
    properties: {
      repo: {
        ...REPO_ARG,
        description:
          "owner/name; all when absent.",
      },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const one =
      typeof args["repo"] === "string" ? repoArg(ctx, user, args) : undefined;
    if (one !== undefined && isAnswer(one)) return one;
    const repos = one === undefined ? appsOf(ctx, user).repos : [one];
    const audited = await Promise.all(
      repos.map((repo) => audit(ctx.app.reposRoot, repo)),
    );
    return good(
      audited.map((a) => ({
        app: `${a.repo.ownerName}/${a.repo.name}`,
        commit: a.oid ?? null,
        // Who may direct the crew is part of who can do what here.
        crewOutsiders: a.repo.crewOutsiders,
        standing: a.standing.kind,
        ...(a.standing.kind === "unsound"
          ? { problems: a.standing.problems }
          : a.standing.kind === "sound"
            ? {
                identities: a.standing.identities,
                open: a.standing.open.map((c) => `${c.resource}.${c.verb}`),
                cells: a.standing.cells.map((c) => ({
                  resource: c.resource,
                  verb: c.verb,
                  as: c.as,
                  answer: c.answer,
                })),
              }
            : {}),
      })),
    );
  },
};
