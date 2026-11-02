import { appsRuntime } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { getUserByName } from "../../../core/users.ts";
import { repositoryLimitMessage } from "../../../actions/repos.ts";
import { NO_NAME_ERROR, newApp, newAppFromSentence, type NewAppInput } from "../../../actions/apps.ts";
import { appLimitWords } from "../../../actions/app_limit.ts";
import { storageLimitMessage } from "../../../core/storage.ts";
import { VERIFY_FIRST } from "../../../actions/verify_words.ts";
import { err, ok } from "../../../kernel/result.ts";
import type { User } from "../../../core/users.ts";
import type { App } from "../../../app.ts";
import { good, bad, type Tool, str } from "../shared.ts";

/** `newAppFromSentence`, answered in `newApp`'s shape so one switch maps both paths' refusals. */
async function fromSentence(app: App, user: User, sentence: string, input: Omit<NewAppInput, "name">) {
  const derived = await newAppFromSentence(app, user, { ...input, sentence });
  return derived.ok ? ok(derived) : err(derived.code);
}

export const tool: Tool = {
  name: "new_app",
  doc: "`{ name?, sentence?, description?, owner?, visibility?, agent?, pick? }`: make an app from a sentence: with `sentence` and no `name` the name is derived from it (`-2`, `-3` when taken), as the web and terminal do; `name` and `sentence` together keep the name; the first issue is `description`, else `sentence`; answers `{ repo, url, issue, agent, run }` (`run` is the first run's state, or `none`) and draws the `ui://forge/app` card: name, production URL, first issue, agent, first run; refused as `POST /api/v1/apps` is (unverified, app_limit, no_such_agent, name_taken)",
  description:
    "Make an app from a sentence: a repo, production, and with `description` a first issue.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      sentence: { type: "string", maxLength: 4000 },
      description: { type: "string", maxLength: 4000, description: "The first issue." },
      owner: { type: "string", maxLength: 39 },
      visibility: { type: "string", enum: ["public", "private"] },
      agent: { type: "string", maxLength: 39 },
      pick: { type: "boolean" },
    },
  },
  writes: true,
  async run(ctx, user, args) {
    const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const visibility = args["visibility"];
    const owner = text("owner");
    const description = text("description");
    const agent = text("agent");
    const sentence = text("sentence");
    const rest: Omit<NewAppInput, "name" | "description"> = {
      ...(owner === undefined ? {} : { owner }),
      ...(visibility === "public" || visibility === "private" ? { visibility } : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(args["pick"] === true ? { pickAgent: true } : {}),
    };
    const given = str(args["name"]).trim();
    const first = description ?? sentence;
    const input = { ...rest, ...(first === undefined ? {} : { description: first }) };
    const made =
      given !== ""
        ? await newApp(ctx.app, user, { ...input, name: given })
        : await fromSentence(ctx.app, user, sentence ?? "", input);
    if (!made.ok) {
      switch (made.error) {
        case "no_name":
          return bad("no_name", NO_NAME_ERROR);
        case "unverified":
          return bad("unverified", VERIFY_FIRST);
        case "app_limit": {
          const who = getUserByName(ctx.app.db, owner || user.username);
          return bad("app_limit", who ? appLimitWords(ctx.app, who.id) : "App limit reached.");
        }
        case "repository_limit":
          return bad("repository_limit", repositoryLimitMessage(ctx.app, user));
        case "storage_limit":
          return bad("storage_limit", storageLimitMessage(ctx.app, user.id));
        default:
          return bad(made.error, made.error);
      }
    }
    const { repo, app: record, issue } = made.value;
    const run = listActiveRuns(ctx.app.db, [repo.id])[0];
    return good({
      repo: `${repo.ownerName}/${repo.name}`,
      url: appsRuntime(ctx.app)?.urlFor(record, "production") ?? null,
      issue: issue === undefined ? null : issue.number,
      agent: issue?.assigneeName ?? null,
      run: run?.state ?? "none",
    });
  },
};
