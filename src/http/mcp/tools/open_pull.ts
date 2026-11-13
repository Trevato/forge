import { openPull } from "../../../actions/pulls.ts";
import { proposeChange, validChecks, validFiles, type ProposeChangeError } from "../../../actions/propose_change.ts";
import { VERIFY_FIRST } from "../../../actions/verify_words.ts";
import { GUEST_REFUSALS, isGuestRefusal } from "../../../core/contribute.ts";
import { getRepo } from "../../../core/repos.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

const changeWords = (f: Extract<ProposeChangeError, object>): string =>
  f.kind === "patch" ? `the patch ${f.reason.replace(/_/g, " ")}: send a unified diff of text files against the base, at most 256 KiB`
  : f.kind === "pull" ? `the branch ${f.branch} is on ${f.fork}; opening the pull failed (${f.reason}): send open_pull with head and headRepo`
  : `${f.kind} failed: ${f.reason}`;

/** The MCP door to `POST /api/v1/repos/:owner/:name/pulls`: the same action, the same refusals. */
export const tool: Tool = {
  name: "open_pull",
  doc: "`{ repo, title, head?, base?, body?, headRepo?, patch?, files?, checks? }`: open a pull into `repo` from branch `head`, of `headRepo` (`owner/name`, a fork of `repo`) when given, as POST `/api/v1/repos/:owner/:name/pulls` does; or send `patch` (a unified diff) or `files` (`[{ path, content }]`) with no git, committed to a branch on your fork as you, with `checks` (what you ran locally). A guest sends only from their own fork, and the pull runs nothing until a person approves it",
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
      patch: { type: "string" },
      files: { type: "array", items: { type: "object" } },
      checks: { type: "array", items: { type: "object" } },
    },
    required: ["repo", "title"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["patch"] !== undefined || args["files"] !== undefined) {
      const checks = validChecks(args["checks"]);
      if (!checks.ok) return bad("invalid", "checks: at most 10 of { name, result: pass|fail|skipped, detail? }");
      const files = args["files"] === undefined ? undefined : validFiles(args["files"]);
      if (files !== undefined && !files.ok) return bad("invalid", "files: 1-50 of [{ path, content }], a safe path, content a string or null to delete, 512 KiB in all");
      if (args["patch"] !== undefined && typeof args["patch"] !== "string") return bad("invalid", "patch is a unified diff, as text");
      const sent = await proposeChange(ctx.app, user, repo, {
        title: str(args["title"]),
        body: str(args["body"]),
        base: str(args["base"]),
        branch: str(args["head"]),
        ...(files === undefined || !files.ok ? {} : { files: files.value }),
        ...(typeof args["patch"] === "string" ? { patch: args["patch"] } : {}),
        checks: checks.value,
      });
      if (sent.ok)
        return good({
          says: `Opened #${sent.value.pull.number} from ${sent.value.fork.ownerName}/${sent.value.fork.name}:${sent.value.branch}, committed as you. A person approves it before any check runs; then the forge runs its own.`,
          number: sent.value.pull.number,
          fork: `${sent.value.fork.ownerName}/${sent.value.fork.name}`,
          branch: sent.value.branch,
          commit: sent.value.commit,
          waitsForApproval: sent.value.waitsForApproval,
        });
      const f = sent.error;
      if (typeof f === "string") {
        if (isGuestRefusal(f)) return bad(f, GUEST_REFUSALS[f]);
        if (f === "unverified") return bad(f, VERIFY_FIRST);
        return bad(f, f.replace(/_/g, " "));
      }
      return bad(f.kind, changeWords(f));
    }
    if (str(args["head"]) === "") return bad("invalid", "head is the branch to send, or send a patch or files");
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
