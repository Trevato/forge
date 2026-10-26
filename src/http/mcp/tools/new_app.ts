import { appsRuntime } from "../../../apps/runtime.ts";
import { listActiveRuns } from "../../../core/runs.ts";
import { getUserByName } from "../../../core/users.ts";
import { repositoryLimitMessage } from "../../../actions/repos.ts";
import { newApp } from "../../../actions/apps.ts";
import { appLimitWords } from "../../../actions/app_limit.ts";
import { storageLimitMessage } from "../../../core/storage.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "new_app",
  doc: "`{ name, description?, owner?, visibility?, agent?, pick? }`: make an app from a sentence; answers `{ repo, url, issue, agent, run }` (`run` is the first run's state, or `none`) and draws the `ui://forge/app` card: name, production URL, first issue, agent, first run; refused as `POST /api/v1/apps` is (unverified, app_limit, no_such_agent, name_taken)",
  description:
    "Make an app from a sentence: a repository, production started, and with `description` a first issue.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", maxLength: 100 },
      description: { type: "string", maxLength: 4000, description: "The first issue." },
      owner: { type: "string", maxLength: 39 },
      visibility: { type: "string", enum: ["public", "private"], description: "Default private." },
      agent: { type: "string", maxLength: 39, description: "Agent for the first issue." },
      pick: { type: "boolean", description: "Pick the agent from the text." },
    },
    required: ["name"],
  },
  writes: true,
  async run(ctx, user, args) {
    const text = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : undefined);
    const visibility = args["visibility"];
    const owner = text("owner");
    const description = text("description");
    const agent = text("agent");
    const made = await newApp(ctx.app, user, {
      name: str(args["name"]),
      ...(owner === undefined ? {} : { owner }),
      ...(description === undefined ? {} : { description }),
      ...(visibility === "public" || visibility === "private" ? { visibility } : {}),
      ...(agent === undefined ? {} : { agent }),
      ...(args["pick"] === true ? { pickAgent: true } : {}),
    });
    if (!made.ok) {
      switch (made.error) {
        case "unverified":
          return bad("unverified", "verify your email first");
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
