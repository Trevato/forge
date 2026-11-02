import { appsRuntime } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { getUserByName } from "../../../core/users.ts";
import { repositoryLimitMessage } from "../../../actions/repos.ts";
import { NO_NAME_ERROR, newApp, newAppFromSentence, type NewAppInput, type NewAppResult } from "../../../actions/apps.ts";
import { appLimitWords } from "../../../actions/app_limit.ts";
import { storageLimitMessage } from "../../../core/storage.ts";
import { VERIFY_FIRST } from "../../../actions/verify_words.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "new_app",
  doc: "`{ name?, sentence?, description?, owner?, visibility?, agent?, pick? }`: make an app from a sentence; `name` wins when both are given, and `sentence` alone derives the name (`no_name` when nothing is left to name from); answers `{ repo, url, issue, agent, run }` (`run` is the first run's state, or `none`) and draws the `ui://forge/app` card: name, production URL, first issue, agent, first run; refused as `POST /api/v1/apps` is (unverified, app_limit, no_such_agent, name_taken)",
  description:
    "Make an app from a sentence: a repo, production, and with `description` a first issue.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      sentence: { type: "string", maxLength: 4000, description: "Names the app when `name` is absent." },
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
    const options: Omit<NewAppInput, "name" | "description"> = {
      ...(owner === undefined ? {} : { owner }),
      ...(visibility === "public" || visibility === "private" ? { visibility } : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(args["pick"] === true ? { pickAgent: true } : {}),
    };
    const sentence = text("sentence");
    let made: { ok: true; value: NewAppResult } | { ok: false; error: string };
    if (str(args["name"]) === "" && sentence !== undefined) {
      const r = await newAppFromSentence(ctx.app, user, { ...options, sentence: str(sentence) });
      made = r.ok ? { ok: true, value: r } : { ok: false, error: r.code };
    } else {
      made = await newApp(ctx.app, user, {
        name: str(args["name"]),
        ...(description === undefined ? {} : { description }),
        ...options,
      });
    }
    if (!made.ok) {
      switch (made.error) {
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
        case "no_name":
          return bad("no_name", NO_NAME_ERROR);
        default:
          return bad(made.error, made.error);
      }
    }
    const { repo, app: record, issue } = made.value;
    const first = listActiveRuns(ctx.app.db, [repo.id])[0];
    return good({
      repo: `${repo.ownerName}/${repo.name}`,
      url: appsRuntime(ctx.app)?.urlFor(record, "production") ?? null,
      issue: issue === undefined ? null : issue.number,
      agent: issue?.assigneeName ?? null,
      run: first?.state ?? "none",
    });
  },
};
