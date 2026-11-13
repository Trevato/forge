import { contextNote, parseContext } from "../../../actions/tell_context.ts";
import { asksMakeANewApp, firstAsk } from "../../../actions/first_ask.ts";
import { crewCanRun } from "../../../web/studio/crew_key.ts";
import { keepThought } from "../../../actions/thought.ts";
import { parseFrom } from "../../../actions/tell_from.ts";
import { FROM_WORDS, tell, toldWords, UNVERIFIED_WORDS } from "../../../actions/tell.ts";
import { DIRECTION_NOTE } from "../../../crew/direct.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "tell",
  doc: "`{ repo?, text, from?, context? }`: a sentence becomes an issue, a builder is picked, a run starts on the crew's next tick",
  description:
    "Tell an app's crew what to change (first line: title). No `repo`: kept.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      text: { type: "string", maxLength: 8000 },
      from: {
        type: "string",
        maxLength: 512,
        description:
          "Forge path to link, as /a/b/pulls/3.",
      },
      context: {
        type: "object",
        properties: {
          page: { type: "string" },
          pull: { type: "integer", minimum: 1 },
          run: { type: "string" },
          commit: { type: "string" },
          said: { type: "string", maxLength: 2000 },
        },
      },
    },
    required: ["text"],
  },
  writes: true,
  async run(ctx, user, args) {
    if (args["repo"] === undefined || args["repo"] === null) {
      // No repository named: a person with no app but the forge's own copy makes a new app.
      if (await asksMakeANewApp(ctx.app, user)) {
        const first = await firstAsk(ctx.app, user, str(args["text"]), crewCanRun(ctx.app));
        if (!first.ok) return bad("invalid", first.error.words);
        const { repo, told } = first.value;
        if (!told.ok) return bad(told.error, "that could not be told here");
        return good({
          says: toldWords(told.value),
          issue: told.value.issue.number,
          page: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${told.value.issue.number}`,
        });
      }
      const kept = keepThought(ctx.app, user, args["text"], "mcp");
      return kept.ok
        ? good({ thought: kept.value.id })
        : bad(
            "invalid",
            "text is a string of at most 20,000 characters",
          );
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const where = parseContext(args["context"]);
    if (where === null)
      return bad(
        "invalid",
        "context is { page?: http(s) address, pull?: number, run?: id, commit?: hex, said?: words }",
      );
    const from = parseFrom(args["from"]);
    if (from === undefined) return bad("invalid", FROM_WORDS);
    const told = await tell(
      ctx.app,
      user,
      repo,
      str(args["text"]) === ""
        ? ""
        : `${str(args["text"])}${contextNote(where)}`,
      1,
      from,
    );
    if (!told.ok)
      return bad(
        told.error,
        told.error === "empty"
          ? "say something first"
          : told.error === "forbidden"
            ? DIRECTION_NOTE
            : told.error === "unverified"
              ? UNVERIFIED_WORDS
              : "that could not be told here",
      );
    return good({
      says: toldWords(told.value),
      issue: told.value.issue.number,
      page: `${ctx.url.origin}/${repo.ownerName}/${repo.name}/issues/${told.value.issue.number}`,
    });
  },
};
