import { rows, tables } from "../../../data/browse.ts";
import { query } from "../../../data/query.ts";
import { findSource, listSources } from "../../../data/sources.ts";
import { bad, good, type Tool } from "../shared.ts";

export const tool: Tool = {
  name: "data",
  doc: "the SQLite files you may read (the forge's own for an admin; each app's per environment for its writers), with `source`: its tables and row counts, with `table` (and `page`): a page of rows, with `sql`: a read-only SELECT (5 s, 1,000 rows); secret columns are masked",
  description: "Read SQLite files you may see: tables, rows, read-only SQL; secrets masked.",
  inputSchema: {
    type: "object",
    properties: {
      source: { type: "string" },
      table: { type: "string" },
      page: { type: "integer" },
      sql: { type: "string" },
    },
  },
  writes: false,
  async run(ctx, user, args) {
    const { db, config } = ctx.app;
    const { source: id, table, page, sql } = args;
    for (const [k, v] of Object.entries({ source: id, table, sql }))
      if (v !== undefined && typeof v !== "string") return bad("invalid", `\`${k}\` is text`);
    if (page !== undefined && typeof page !== "number") return bad("invalid", "`page` is a number");
    if (id === undefined) {
      return good(listSources(db, config.dataDir, user).map((s) => ({ source: s.id, label: s.label })));
    }
    const source = findSource(db, config.dataDir, user, id as string);
    if (!source) return bad("not_found", "no such source");
    if (sql !== undefined) {
      const result = await query(source, sql as string);
      return result.ok ? good(result) : bad("invalid", result.message);
    }
    if (table === undefined) return good(tables(source));
    const found = rows(source, table as string, page === undefined ? {} : { page: page as number });
    return found ? good(found) : bad("not_found", "no such table");
  },
};
