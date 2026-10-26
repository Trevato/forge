import { mayView } from "../../../core/sealed.ts";
import { pullThreads, resolveReviewThread } from "../../../actions/pulls.ts";
import { getPull } from "../../../core/pulls.ts";
import { good, bad, type Tool, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "threads",
  doc: "`{ repo, number, anchor?, resolved? }`: a pull's review threads with their comments; with `anchor` (from the list) resolve it (`resolved` true, the default) or reopen it (false), by the API's rules: a writer or someone who commented in the thread",
  description:
    "A pull's review threads; with `anchor`, resolve one or reopen it (`resolved` false).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      anchor: { type: "string", maxLength: 16 },
      resolved: { type: "boolean" },
    },
    required: ["repo", "number"],
  },
  writes: true,
  readsWithout: "anchor",
  run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const n = args["number"];
    const anchor = args["anchor"];
    const resolved = args["resolved"];
    if (anchor !== undefined && (typeof anchor !== "string" || !/^[0-9a-f]{16}$/.test(anchor)))
      return bad("invalid", "`anchor` is a thread's anchor, as the list gives it");
    if (resolved !== undefined && typeof resolved !== "boolean")
      return bad("invalid", "`resolved` is true or false");
    if (anchor === undefined && resolved !== undefined)
      return bad("invalid", "`resolved` needs an `anchor`");
    const pull =
      typeof n === "number" && Number.isInteger(n) && n > 0
        ? getPull(ctx.app.db, repo.id, n)
        : undefined;
    if (pull === undefined || !mayView(ctx.app.db, repo, pull, user))
      return bad("no_such_pull", `no pull #${String(n)}`);
    const url = `/${repo.ownerName}/${repo.name}/pulls/${pull.number}`;
    if (anchor === undefined) {
      const threads = pullThreads(ctx.app, pull);
      const open = threads.filter((t) => t.resolvedAt === null).length;
      return good({
        threads,
        url,
        says: `${threads.length} thread${threads.length === 1 ? "" : "s"}, ${open} open.`,
      });
    }
    const want = resolved !== false;
    const done = resolveReviewThread(ctx.app, user, repo, pull, anchor, want);
    if (!done.ok)
      return bad(
        done.error === "not_found" ? "no_such_thread" : "refused",
        done.error === "not_found"
          ? "No such thread on this pull."
          : done.error === "forbidden"
            ? "Only a writer or someone in the thread may settle it."
            : "You may not settle this thread.",
      );
    return good({
      ...done.value,
      url,
      says: want ? "Thread resolved." : "Thread reopened.",
    });
  },
};
