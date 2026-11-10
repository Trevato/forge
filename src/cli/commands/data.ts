import { ForgeApi } from "../api.ts";
import { requireConfig } from "../context.ts";
import { EXIT } from "../exit.ts";
import { cell, inert, type Out } from "../out.ts";
import { cellLine, rowObject, type Cell } from "../../data/shape.ts";
import type { Command } from "./types.ts";

interface Listed {
  source: string;
  label: string;
}

const isList = (v: unknown): v is Listed[] =>
  Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null && typeof (x as Listed).source === "string" && typeof (x as Listed).label === "string");

const ENV = /^(production|pull-[1-9]\d*|build-[0-9a-f]{7})$/;

/** The file `forge data <app> [env]` means, among those the forge listed; an error message when it is none or many. */
export function pick(list: readonly Listed[], app: string, env: string | undefined, file: string | undefined): Listed | string {
  const parts = (l: Listed) => l.label.split(" · ");
  const named = list.filter((l) => {
    const [slug, e, f] = parts(l);
    return slug === app && (env === undefined || e === env) && (file === undefined || f === file);
  });
  if (named.length === 0) return `no database for ${[app, env, file].filter(Boolean).join(" ")} that you may read`;
  const prod = named.filter((l) => parts(l)[1] === "production");
  const pool = env === undefined && prod.length > 0 ? prod : named;
  const preferred = pool.filter((l) => parts(l)[2] === "app.db");
  const chosen = file === undefined && preferred.length > 0 ? preferred : pool;
  if (chosen.length === 1) return chosen[0]!;
  return `several databases match: ${chosen.map((l) => l.label.replaceAll(" · ", " ")).join(", ")} — name the env, or pass --file`;
}

function show(out: Out, columns: readonly string[], rows: readonly (readonly Cell[])[], json: boolean): void {
  if (json) {
    out.line(JSON.stringify(rows.map((r) => rowObject(columns, r))));
    return;
  }
  if (rows.length === 0) {
    out.line("No rows.");
    return;
  }
  out.table(
    columns.map((header) => ({ header, max: 40 })),
    rows.map((r) => r.map((v) => cell(cellLine(v)))),
  );
}

/**
 * `forge data` lists the databases you may read; `forge data <app> [env]`
 * its tables; with `--table` a page of rows; with SQL the answer to a
 * read-only SELECT. The forge decides what you may see and masks secrets.
 */
async function data(out: Out, args: Parameters<Command["run"]>[1]): Promise<number> {
  const loaded = await requireConfig(out);
  if (typeof loaded === "number") return loaded;
  const json = args.flag("json");
  const api = new ForgeApi(loaded.url, loaded.token);
  const fail = (m: string, code: number = EXIT.failed): number => (out.err(`forge data: ${inert(m)}`), code);

  const listed = await api.tool("data", {});
  if (!listed.ok) return fail(listed.error.message, listed.error.status === 401 ? EXIT.notConfigured : EXIT.failed);
  if (!isList(listed.value)) return fail("unexpected answer");

  const [app, ...rest] = args.positional;
  if (app === undefined) {
    if (json) out.line(JSON.stringify(listed.value));
    else if (listed.value.length === 0) out.line("No databases you may read.");
    else for (const l of listed.value) out.line(inert(l.label.replaceAll(" · ", " ")));
    return EXIT.ok;
  }
  // `[env] [sql]`: a lone word that names an environment is the env; anything else is SQL.
  const env = rest[0] !== undefined && ENV.test(rest[0]) ? rest.shift() : undefined;
  const sql = rest.join(" ").trim();
  if (sql === "" && rest.length > 0) return fail("empty SQL", EXIT.usage);

  const chosen = pick(listed.value, app, env, args.value("file"));
  if (typeof chosen === "string") return fail(chosen, EXIT.usage);

  const table = args.value("table");
  if (table !== undefined && sql !== "") return fail("--table and SQL together: pick one", EXIT.usage);
  const rawPage = args.value("page");
  if (args.flag("page") && (rawPage === undefined || !/^\d{1,4}$/.test(rawPage))) return fail("--page is a whole number, 0 or more", EXIT.usage);
  const answer = await api.tool("data", {
    source: chosen.source,
    ...(sql !== "" ? { sql } : table !== undefined ? { table } : {}),
    ...(rawPage !== undefined ? { page: Number(rawPage) } : {}),
  });
  if (!answer.ok) return fail(answer.error.message);
  const v = answer.value as { columns?: string[]; rows?: Cell[][]; truncated?: boolean };
  if (Array.isArray(answer.value)) {
    const tables = answer.value as { name: string; rows: number }[];
    if (json) out.line(JSON.stringify(tables));
    else if (tables.length === 0) out.line("No tables.");
    else out.table([{ header: "TABLE" }, { header: "ROWS", align: "right" }], tables.map((t) => [cell(t.name), cell(String(t.rows))]));
    return EXIT.ok;
  }
  if (!Array.isArray(v.columns) || !Array.isArray(v.rows)) return fail("unexpected answer");
  show(out, v.columns, v.rows, json);
  if (v.truncated === true) out.err("forge data: the answer was cut at the forge's cap");
  return EXIT.ok;
}

export const command: Command = {
  name: "data",
  usage: { synopsis: "forge data [app] [env] [sql]", flags: "[--table name] [--file x.db] [--page n] [--json]" },
  run: (out, args) => data(out, args),
};
