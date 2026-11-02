import { migrateMessage, migrateRepo, migrationJobFor } from "../../../actions/migrate.ts";
import type { MirrorJob } from "../../../origins/jobs.ts";
import { repositoryLimitMessage } from "../../../actions/repos.ts";
import { storageLimitMessage } from "../../../core/storage.ts";
import { good, bad, type Tool, str } from "../shared.ts";

export const tool: Tool = {
  name: "migrate",
  doc: "`{ url, name?, crew? }` brings a public repository in by URL (history only; nothing reaches back) and answers `{ job, state, url }`; `{ job }` alone reads that job. Same validation, scope (`rw`) and private-address refusal as `POST /api/v1/migrate`",
  description:
    "Bring a repo in by public `url` (`name`, `crew`), history and all. With `job`, its state.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", maxLength: 2048 },
      name: { type: "string", maxLength: 100 },
      crew: { type: "string", maxLength: 39 },
      job: { type: "string", maxLength: 64 },
    },
  },
  writes: true,
  readsWithout: "url",
  async run(ctx, user, args) {
    const migration = (job: MirrorJob) => ({
      job: job.id,
      state: job.stage,
      detail: job.detail,
      url:
        job.repo === undefined || job.stage === "failed"
          ? null
          : `${ctx.url.origin}/${job.repo.ownerName}/${job.repo.name}`,
      error: job.error ?? null,
    });
    const url = args["url"];
    if (url === undefined) {
      const id = str(args["job"]);
      if (id === "") return bad("invalid", "send `url` to migrate, or `job` to read one");
      const found = migrationJobFor(user, id);
      return found.ok ? good(migration(found.value)) : bad("not_found", "no such migration");
    }
    if (typeof url !== "string") return bad("invalid", "`url` is a string");
    const name = args["name"];
    const crew = args["crew"];
    if (name !== undefined && typeof name !== "string") return bad("invalid", "`name` is a string");
    if (crew !== undefined && typeof crew !== "string") return bad("invalid", "`crew` is a string");
    const started = await migrateRepo(ctx.app, user, {
      source: { url },
      ...(name === undefined ? {} : { name }),
      ...(crew === undefined ? {} : { crew: { agent: crew, autonomous: false } }),
    });
    if (!started.ok)
      return started.error === "unauthorized"
        ? bad("unauthorized", "sign in to migrate")
        : started.error === "repository_limit"
          ? bad("repository_limit", repositoryLimitMessage(ctx.app, user))
          : started.error === "storage_limit"
            ? bad("storage_limit", storageLimitMessage(ctx.app, user.id))
            : bad(started.error, migrateMessage(started.error));
    return good({
      ...migration(started.value.job),
      url: `${ctx.url.origin}/${started.value.repo.ownerName}/${started.value.repo.name}`,
    });
  },
};
