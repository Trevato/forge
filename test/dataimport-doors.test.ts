/**
 * The database import through the terminal and MCP doors (#11697): the same
 * gate as the API (the repository's admin; anyone else is offered nothing and
 * changes nothing), the same engine, the same words.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { envDataDir } from "../src/apps/data.ts";
import { readStagedDump } from "../src/apps/dump_file.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { dataImportCommands, importStaged } from "../src/tui/screens/dataimport.ts";
import type { Ctx } from "../src/tui/app/app.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let cy: User; // admin of the repository
let dee: User; // a reader
let repo: Repo;
let appId: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-import-doors-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  const make = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  await make("ada", true);
  cy = await make("cy");
  promote(app.db, cy);
  dee = await make("dee");
  const made = await createRepo(app, cy, { name: "shop", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const row = insertApp(app.db, { repoId: repo.id, slug: "shop", access: "public" });
  if (!row.ok) throw new Error(row.error);
  appId = row.value.id;
  const dir = join(envDataDir(dataDir, appId, "production"), "imports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dump.sql"), "CREATE TABLE t(a); INSERT INTO t VALUES (1),(2);");
}, 60_000);

afterAll(async () => {
  app.db.close();
  await rm(dataDir, { recursive: true, force: true });
});

const session = (user: User | undefined) => ({ user, db: app.db, app }) as unknown as Session;
const ctx = { toast() {}, invalidate() {}, push() {} } as unknown as Ctx;

describe("terminal", () => {
  test("only the repository's admin is offered the screen", () => {
    expect(dataImportCommands(session(cy), ctx, repo).map((c) => c.id)).toEqual(["data-import"]);
    expect(dataImportCommands(session(dee), ctx, repo)).toEqual([]);
    expect(dataImportCommands(session(undefined), ctx, repo)).toEqual([]);
    expect(dataImportCommands(session(cy), ctx, undefined)).toEqual([]);
  });
  test("a non-admin's import is refused and writes nothing", () => {
    const refused = importStaged(session(dee), repo, "dump.sql", false);
    expect(refused.ok).toBe(false);
    expect(existsSync(join(envDataDir(dataDir, appId, "production"), "app.db"))).toBe(false);
  });
  test("the admin's import loads a staged file and reports per table", () => {
    const done = importStaged(session(cy), repo, "dump.sql", false);
    expect(done.ok && done.report.tables.map((t) => [t.table, t.rows, t.inserted, t.match])).toEqual([["t", 2, 2, true]]);
    const again = importStaged(session(cy), repo, "dump.sql", false);
    expect(again).toMatchObject({ ok: false });
  });
  test("a file name is a plain .sql name that exists", () => {
    const dir = envDataDir(dataDir, appId, "production");
    for (const name of ["../app.db", "a/b.sql", "dump.txt", ".sql", ""]) expect(readStagedDump(dir, name)).toEqual({ ok: false, error: "invalid_name" });
    expect(readStagedDump(dir, "nope.sql")).toEqual({ ok: false, error: "missing" });
  });
});

describe("MCP app_data_import", () => {
  const tool = TOOLS.find((t) => t.name === "app_data_import")!;
  const call = (user: User, args: Record<string, unknown>) => tool.run({ app } as never, user, args);
  test("is a write tool, registered", () => {
    expect(tool.writes).toBe(true);
  });
  test("a non-admin is told not_found; an admin loads; a refused dump says why", async () => {
    const dump = "CREATE TABLE m(a); INSERT INTO m VALUES (1);";
    expect(await call(dee, { repo: "cy/shop", dump, file: "m.db" })).toMatchObject({ ok: false, error: "not_found" });
    const done = await call(cy, { repo: "cy/shop", dump, file: "m.db" });
    expect(done).toMatchObject({ ok: true });
    expect(await call(cy, { repo: "cy/shop", dump: "CREATE TABLE x AS SELECT 1", file: "x.db" })).toMatchObject({ ok: false, error: "refused" });
    expect(await call(cy, { repo: "cy/shop", dump, file: "m.db" })).toMatchObject({ ok: false, error: "exists" });
  });
});
