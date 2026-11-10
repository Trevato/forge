import { mayView } from "../../../core/sealed.ts";
import { addCommentThrough } from "../../../actions/issues.ts";
import { getIssue } from "../../../core/issues.ts";
import { archiveConversation, createConversation, getConversation, listConversations, renameConversation, TOO_MANY_WORDS } from "../../../core/conversations.ts";
import { BUILD_WORDS, buildState, publishBuild, restoreVersion, startBuild, versionDiff, type BuildError } from "../../../actions/build.ts";
import { BUILD_ID, promptRefusal, templateRefusal, versionRefusal } from "../../../actions/build_input.ts";
import { talk, TALK_WORDS } from "../../../actions/talk.ts";
import { WORDS_MAX } from "../../../core/fence.ts";
import { good, bad, type Tool, str, REPO_ARG, repoArg, isAnswer } from "../shared.ts";

const BUILD_ACTIONS = ["build", "build_state", "build_diff", "build_restore", "build_publish"];
const buildBad = (error: BuildError) => bad(error, BUILD_WORDS[error] ?? error);

export const tool: Tool = {
  name: "say",
  doc: "`{ repo?, number?, text?, conversation?, action?, title?, archived? }`: speak on an issue or a pull; a working builder hears it as its next step. With no `repo` or `number` it speaks to the forge's own agent (`forge talk`), which answers in `GET /api/v1/conversation/turns`. `conversation` names one of your conversations (default: the latest); `action` list | new | rename | archive | restore manages them (`title` for rename and new; `archived` lists archived ones); `action` build (`text` prompt, `template`) | build_state | build_diff (`version`) | build_restore (`version`) | build_publish drives a talk build of `conversation`",
  description:
    "Say something on an issue or pull; with no repo, to the forge's own agent, and manage its conversations (action).",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      number: { type: "integer", minimum: 1 },
      text: { type: "string", maxLength: 8000 },
      conversation: { type: "string" },
      action: { type: "string", enum: ["list", "new", "rename", "archive", "restore", ...BUILD_ACTIONS] },
      template: { type: "string" },
      version: { type: "integer", minimum: 1 },
      title: { type: "string", maxLength: 80 },
      archived: { type: "boolean" },
    },
  },
  writes: true,
  readsWhen: (args) => args["repo"] === undefined && args["number"] === undefined && (args["action"] === "build_state" || args["action"] === "build_diff"),
  async run(ctx, user, args) {
    if (args["repo"] === undefined && args["number"] === undefined) {
      // The forge's own agent never wakes itself: its via token is refused.
      if (ctx.auth.through !== undefined) return bad("forbidden", "the forge's agent cannot start its own turn");
      const db = ctx.app.db;
      const action = args["action"];
      if (action === "list") return good({ conversations: listConversations(db, user.id, { archived: args["archived"] === true }).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) });
      if (typeof action === "string" && BUILD_ACTIONS.includes(action)) {
        if (action === "build") {
          const prompt = args["text"];
          const badPrompt = promptRefusal(prompt, "text");
          if (badPrompt !== undefined || typeof prompt !== "string") return bad("invalid_prompt", badPrompt ?? "");
          const template = args["template"];
          const badTemplate = templateRefusal(template);
          if (badTemplate !== undefined || (template !== undefined && typeof template !== "string")) return bad("invalid_template", badTemplate ?? "");
          const started = await startBuild(ctx.app, user, { prompt, ...(template === undefined ? {} : { template }) });
          if (!started.ok) return buildBad(started.error);
          const { build, repo, said } = started.value;
          return good({ conversation: build.conversationId, repo: `${repo.ownerName}/${repo.name}`, branch: build.branch, ...(said === undefined ? {} : { said, message: TALK_WORDS[said][1] }) });
        }
        const id = str(args["conversation"]);
        if (!BUILD_ID.test(id)) return buildBad("not_found");
        if (action === "build_state") {
          const state = await buildState(ctx.app, user, id);
          if (!state.ok) return buildBad(state.error);
          const v = state.value;
          return good({ repo: v.repoName, branch: v.build.branch, versions: v.versions, previewUrl: v.previewUrl, previewState: v.previewState, published: v.published, productionUrl: v.productionUrl });
        }
        if (action === "build_publish") {
          const published = await publishBuild(ctx.app, user, id);
          return published.ok ? good({ published: true, productionUrl: published.value.productionUrl }) : buildBad(published.error);
        }
        const n = args["version"];
        const badVersion = versionRefusal(n);
        if (badVersion !== undefined || typeof n !== "number") return bad("invalid_version", badVersion ?? "");
        if (action === "build_diff") {
          const diff = await versionDiff(ctx.app, user, id, n);
          return diff.ok ? good(diff.value) : buildBad(diff.error);
        }
        const restored = await restoreVersion(ctx.app, user, id, n);
        return restored.ok ? good({ version: restored.value }) : buildBad(restored.error);
      }
      if (action === "new") {
        const started = createConversation(db, user.id);
        if (!started.ok) return bad("too_many", TOO_MANY_WORDS);
        const made = started.value;
        const title = str(args["title"]);
        if (title !== "" && !renameConversation(db, user.id, made.id, title).ok) return bad("invalid_title", "title is up to 80 characters, on one line");
        return good({ conversation: made.id, says: "Started; send text with this conversation to speak in it. It opens at /talk/" + made.id + "." });
      }
      if (action !== undefined) {
        const target = getConversation(db, user.id, str(args["conversation"]));
        if (target === undefined) return bad("not_found", "no such conversation of yours");
        if (action === "rename") {
          if (typeof args["title"] !== "string") return bad("invalid_title", "rename needs a title");
          const named = renameConversation(db, user.id, target.id, args["title"]);
          return named.ok ? good({ says: "Renamed." }) : bad("invalid_title", "title is up to 80 characters, on one line");
        }
        if (action !== "archive" && action !== "restore") return bad("invalid", "action is list, new, rename, archive or restore");
        archiveConversation(db, user.id, target.id, action === "archive");
        return good({ says: action === "archive" ? "Archived." : "Restored." });
      }
      if (typeof args["text"] !== "string") return bad("invalid_text", "say needs `text` (or an `action` to manage conversations)");
      const text = args["text"];
      if (text.trim() === "" || text.length > WORDS_MAX) return bad("invalid_text", `text is 1 to ${WORDS_MAX} characters`);
      const named = args["conversation"] === undefined ? undefined : str(args["conversation"]);
      const talked = talk(ctx.app, user, text, [], "inject", named);
      if (!talked.ok) return bad(talked.error, TALK_WORDS[talked.error][1]);
      return good({ says: talked.value.how === "steered" ? "Said to the forge's agent, mid-answer." : "The forge's agent is answering; read it in GET /api/v1/conversation/turns." });
    }
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const issue = getIssue(ctx.app.db, repo.id, Number(args["number"]));
    if (issue === undefined || !mayView(ctx.app.db, repo, issue, user))
      return bad("not_found", "no issue or pull by that number");
    const said = await addCommentThrough(
      ctx.app,
      user,
      repo,
      issue,
      str(args["text"]),
    );
    return said.ok
      ? good({ says: `Said on #${issue.number}.` })
      : bad("refused", "that could not be said here");
  },
};
