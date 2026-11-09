/**
 * The data browser addressed by repository, env and file: what `/api/v1/repos/:o/:n/data…` and the
 * MCP `data` tool (with `repo`) answer. Visibility is `listSources` alone, so a reader, a guest and
 * a stranger see exactly what the web shows them: nothing, as a 404.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { getAppByRepo } from "../core/apps.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isEnvName } from "../apps/data.ts";
import { rows, tables } from "./browse.ts";
import { query } from "./query.ts";
import { sqlWindow } from "./sql_window.ts";
import { listSources, type Source } from "./sources.ts";

/**
 * The one guard of every door: the sources of the repository's app this viewer may read, or
 * undefined (a 404 to the caller) when the viewer cannot write to the repository: a reader, a
 * guest or a stranger has no door to the data. An empty list means a writer, and no database yet.
 */
export function repoSources(db: Database, dataDir: string, viewer: User | undefined, repo: Repo): Source[] | undefined {
  if (viewer === undefined || !canWrite(db, repo, viewer)) return undefined;
  const app = getAppByRepo(db, repo.id);
  if (app === undefined) return [];
  const prefix = `app:${app.id}:`;
  return listSources(db, dataDir, viewer).filter((s) => s.kind === "app" && s.id.startsWith(prefix));
}

/** A page number as REST and MCP both take it: a whole number from 0 to 1000, else undefined. */
export function parsePage(raw: unknown): number | undefined {
  if (typeof raw === "string") return /^[0-9]{1,4}$/.test(raw) && Number(raw) <= MAX_PAGE ? Number(raw) : undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= MAX_PAGE ? raw : undefined;
}
const MAX_PAGE = 1000;

export interface Pick {
  readonly env?: string | undefined;
  readonly file?: string | undefined;
}

export type Failure = { readonly error: "not_found" | "invalid"; readonly message: string };

/** `{ env, file }` to one source; both are checked, then looked up in the allowed list. */
export function pickSource(sources: readonly Source[], pick: Pick): Source | Failure {
  const { env, file } = pick;
  if (env === undefined || file === undefined) return { error: "invalid", message: "`env` and `file` name a database" };
  if (!isEnvName(env)) return { error: "invalid", message: "`env` is an environment name" };
  const found = sources.find((s) => {
    const part = s.id.split(":");
    return part.length === 4 && part[2] === env && part[3] === file;
  });
  return found ?? { error: "not_found", message: "no such database" };
}

export const isFailure = (v: Source | Failure): v is Failure => "error" in v;

export const sourceList = (sources: readonly Source[]) =>
  sources.map((s) => {
    const [, , env, file] = s.id.split(":");
    return { env, file, label: s.label };
  });

export const tableList = (source: Source) => tables(source);

export function rowPage(source: Source, table: string, page: number | undefined) {
  return rows(source, table, page === undefined ? {} : { page });
}

export type SqlOutcome = Awaited<ReturnType<typeof query>> | { readonly ok: false; readonly error: "rate"; readonly message: string; readonly retryAfter: number };

/** Read-only SQL: the same checks, caps and masking as the web (`query.ts`), and its per-person budget (`sql_window.ts`). */
export async function runSql(app: App, user: User, source: Source, sql: string): Promise<SqlOutcome> {
  const wait = sqlWindow(app, user.id);
  if (wait !== undefined) return { ok: false, error: "rate", message: `too many queries: try again in ${wait} s`, retryAfter: wait };
  return query(source, sql);
}
