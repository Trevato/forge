import { importAppData, importDataMessage } from "../../../actions/migrate.ts";
import { bad, good, isAnswer, repoArg, str, type Tool } from "../shared.ts";
import { REPO_ARG } from "../shared.ts";

export const tool: Tool = {
  name: "app_data_import",
  doc: "`{ repo, dump, env?, file?, replace? }` as `POST …/data-import`: load SQL text (`sqlite3 .dump` kind, up to 16 MB: CREATE TABLE, CREATE INDEX, INSERT … VALUES, BEGIN, COMMIT) into an app's SQLite store; a repository admin's. Answers per table the dump's rows and checksum, the store's, and `match`; 409 `exists` unless `replace` (the old file is kept as `<file>.before-import-<time>`), 409 `mismatch` changes nothing",
  description: "Load a SQL dump into an app's database and report per-table counts and checksums; admins only.",
  inputSchema: {
    type: "object",
    properties: {
      repo: REPO_ARG,
      dump: { type: "string" },
      env: { type: "string" },
      file: { type: "string" },
      replace: { type: "boolean" },
    },
    required: ["repo", "dump"],
  },
  writes: true,
  async run(ctx, user, args) {
    const repo = repoArg(ctx, user, args);
    if (isAnswer(repo)) return repo;
    const dump = args["dump"];
    if (typeof dump !== "string") return bad("invalid_dump", "dump is the SQL text");
    if (Buffer.byteLength(dump) > 16 * 1024 * 1024) return bad("too_large", "the dump is over 16 MB");
    const env = str(args["env"]);
    const file = str(args["file"]);
    const done = importAppData(ctx.app, user, repo, {
      dump,
      ...(env !== "" ? { env } : {}),
      ...(file !== "" ? { file } : {}),
      replace: args["replace"] === true,
    });
    if (done.ok) return good(done.value);
    const code = typeof done.error === "string" ? done.error : done.error.error;
    return bad(code, importDataMessage(done.error));
  },
};
