import { APP_ALREADY_YOURS } from "../../../actions/origin_app_words.ts";
import { NOT_A_MEMBER } from "../../../core/roles.ts";
import {
  COPIES_PER_DAY,
  makeItYours,
  receiptWords,
  undoMakeItYours,
} from "../../../actions/make_it_yours.ts";
import { PROVE_FIRST } from "../../../actions/verify_words.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";
import { VISIBILITY_WORDS } from "../../../core/arg_words.ts";

export const tool: Tool = {
  name: "make_it_yours",
  doc: "`{ repo, name?, visibility?, dryRun? }`: a fork of an app you can see, as your own app, following the original; code and history copied, data and secrets not; private unless `visibility` is public (a public original only); at most 5 copies an account a day; plans unless `dryRun` is false; `undo: true` removes the copy while it has nothing of your own",
  description:
    "Fork an app you can see: code and history, following the original.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      name: { type: "string" },
      visibility: { type: "string", enum: ["private", "public"] },
      dryRun: { type: "boolean" },
      undo: { type: "boolean" },
    },
    required: ["repo"],
  },
  writes: true,
  dryByDefault: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    if (args["undo"] === true) {
      const undone = await undoMakeItYours(ctx.app, user, repo);
      if (undone.ok) return good(undone.value);
      return undone.error.kind === "changed"
        ? bad("changed", undone.error.message)
        : undone.error.kind === "unauthorized"
          ? bad("unauthorized", "sign in to undo")
          : undone.error.kind === "failed"
            ? bad("failed", "the copy could not be removed; try again")
            : bad("not_found", "nothing of yours was made from that app");
    }
    const name = str(args["name"]);
    const visibility = str(args["visibility"]);
    if (visibility !== "" && visibility !== "public" && visibility !== "private")
      return bad("invalid", VISIBILITY_WORDS);
    const made = await makeItYours(ctx.app, user, repo, {
      dryRun: args["dryRun"] !== false,
      ...(name === "" ? {} : { name }),
      ...(visibility === "" ? {} : { visibility }),
    });
    if (!made.ok)
      return made.error.kind === "limit"
        ? bad("limit", `at most ${COPIES_PER_DAY} copies a day; another after ${made.error.resetsAt}`)
        : made.error.kind === "repository_limit"
        ? bad("repository_limit", made.error.message)
        : made.error.kind === "storage_limit"
        ? bad("storage_limit", made.error.message)
        : made.error.kind === "invalid"
        ? bad("invalid", made.error.message)
        : made.error.kind === "own"
          ? bad("own", APP_ALREADY_YOURS)
          : made.error.kind === "not_member"
            ? bad("not_member", NOT_A_MEMBER)
          : made.error.kind === "unverified"
            ? bad("unverified", PROVE_FIRST)
            : bad("not_found", "no such app or repository (owner/name)");
    const { made: done, ...plan } = made.value;
    return good(
      done === undefined
        ? plan
        : { ...plan, says: receiptWords(plan), url: `/${done.repo.ownerName}/${done.repo.name}` },
    );
  },
};
