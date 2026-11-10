import { rows, tables } from "../../../data/browse.ts";
import { findSource, listSources } from "../../../data/sources.ts";
import { isFailure, parsePage, pickSource, repoSources, rowPage, runSql, sourceList, tableList } from "../../../data/repo_scope.ts";
import { bad, good, isAnswer, repoArg, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "data",
  doc: "`{ repo, env?, file?, table?, sql? }` as `GET …/data`: an app's databases, then `env`+`file`: its tables, `table`: rows, `sql`: one read-only SELECT; its writers only. Without `repo`: the SQLite files you may read (the forge's own for an admin; each app's per environment for its writers), with `source`: its tables and row counts, with `table` (and `page`): a page of rows, with `sql`: a read-only SELECT (5 s, 1,000 rows); secret columns are masked",
  description: "Read SQLite files you may see: tables, rows, read-only SQL; secrets masked.",
  inputSchema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      env: { type: "string" },
      file: { type: "string" },
      source: { type: "string" },
      table: { type: "string" },
      page: { type: "integer" },
      sql: { type: "string" },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const { db, config } = ctx.app;
    for (const k of ["source", "table", "sql", "env", "file"])
      if (args[k] !== undefined && typeof args[k] !== "string") return bad("invalid", `\`${k}\` is text`);
    const str = (k: string): string | undefined => {
      const v = args[k];
      return typeof v === "string" ? v : undefined;
    };
    const [id, table, sql, env, file] = ["source", "table", "sql", "env", "file"].map(str);
    const page = args["page"];
    const pageNo = page === undefined || typeof page !== "number" ? undefined : parsePage(page);
    if (page !== undefined && pageNo === undefined) return bad("invalid", "`page` is a whole number from 0 to 1000");
    if (args["repo"] !== undefined) {
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      const sources = repoSources(db, config.dataDir, user, repo);
      if (sources === undefined) return bad("not_found", "no such app or repository (owner/name)");
      if (env === undefined && file === undefined) return good({ items: sourceList(sources) });
      const picked = pickSource(sources, { env, file });
      if (isFailure(picked)) return bad(picked.error, picked.message);
      if (typeof sql === "string") {
        const result = await runSql(ctx.app, user, picked, sql);
        return result.ok ? good(result) : bad(result.error === "rate" ? "rate_limited" : "invalid", result.message);
      }
      if (table === undefined) return good({ items: tableList(picked) });
      const found = rowPage(picked, table, pageNo);
      return found ? good(found) : bad("not_found", "no such table");
    }
    if (id === undefined) {
      return good(listSources(db, config.dataDir, user).map((s) => ({ source: s.id, label: s.label })));
    }
    const source = findSource(db, config.dataDir, user, id);
    if (!source) return bad("not_found", "no such source");
    if (typeof sql === "string") {
      const result = await runSql(ctx.app, user, source, sql);
      return result.ok ? good(result) : bad(result.error === "rate" ? "rate_limited" : "invalid", result.message);
    }
    if (table === undefined) return good(tables(source));
    const found = rows(source, table, pageNo === undefined ? {} : { page: pageNo });
    return found ? good(found) : bad("not_found", "no such table");
  },
};
