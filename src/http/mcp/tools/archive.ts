import { scopeAllows } from "../../../core/tokens.ts";
import { setArchived } from "../../../actions/repos.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, MAX_ARCHIVE_REPOS, archiveMany, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "archive",
  doc: "`{ repo | repos, archived?, dryRun? }`: archive (true) or wake (false) a repository, by name; planned first (`dryRun` is true unless `false`); only the repository's admin with an admin token, never an agent. `repos` (at most 50) runs the fleet `archive` operation over them, answers each one's outcome and the `operation` id; `limb` with `action: \"undo\"`, that `operation` and any one of the repositories as `app` reverts it for a day",
  description:
    "Archive or wake a repository (`archived`). Plans first; admin token.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      repos: {
        type: "array",
        items: { type: "string" },
        maxItems: MAX_ARCHIVE_REPOS,
        description: "owner/name list, one operation.",
      },
      archived: { type: "boolean" },
      dryRun: { type: "boolean" },
    },
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    if (args["repos"] !== undefined) return archiveMany(ctx, user, args);
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const archived = args["archived"];
    if (archived === undefined) return good({ archived: repo.archivedAt !== null });
    if (typeof archived !== "boolean")
      return bad("invalid", "`archived` is true or false");
    const dryRun = args["dryRun"] !== false;
    if (!dryRun && !scopeAllows(ctx.auth.scope ?? "ro", "admin"))
      return bad("forbidden", "archiving or waking needs an admin token");
    const set = await setArchived(ctx.app, user, repo, archived, dryRun);
    if (!set.ok)
      return bad("forbidden", "only an admin of this repository archives or wakes it");
    return good({
      ...set.value,
      says: dryRun
        ? `This is the plan; nothing changed. It is ${set.value.was ? "archived" : "awake"} now; send dryRun: false to ${set.value.archived ? "archive" : "wake"} it.`
        : set.value.archived
          ? "Archived: put away, not deleted."
          : "Restored.",
    });
  },
};
