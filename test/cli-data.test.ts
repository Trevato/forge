/** `forge data`: lists, tables, rows and read-only SQL, from a shell, over the MCP tool. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { envDataDir } from "../src/apps/data.ts";
import { EXIT, main } from "../src/cli/main.ts";
import { pick } from "../src/cli/commands/data.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createRepo } from "../src/core/repos.ts";
import { SQL_PER_MINUTE } from "../src/data/sql_window.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
const token: Record<string, string> = {};
const env = { url: process.env["FORGE_URL"], token: process.env["FORGE_TOKEN"] };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-cli-data-"));
  app = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  servers = await serve(app);
  const ids: Record<string, string> = {};
  for (const name of ["owner1", "alice", "bob"]) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: name, email: `${name}@forge.local`, password: "a-good-passphrase", adminIfFirst: name === "owner1" });
    if (!made.ok) throw new Error(made.error);
    ids[name] = made.value.id;
    token[name] = createToken(app.db, made.value.id, "t", "admin").token;
  }
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: ids["alice"]!, name: "notes", visibility: "public" });
  if (!repo.ok) throw new Error(repo.error);
  const rec = createAppRecord(app.db, { repoId: repo.value.id, slug: "notes", access: "public" });
  if (!rec.ok) throw new Error(rec.error);
  const where = envDataDir(dir, rec.value.id, "production");
  mkdirSync(where, { recursive: true });
  const d = new Database(join(where, "app.db"));
  d.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, api_token TEXT)");
  d.exec("INSERT INTO users VALUES (1, 'ann-visible', 'tok-secret-1')");
  d.exec("CREATE TABLE big (id INTEGER PRIMARY KEY)");
  d.exec("WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < 60) INSERT INTO big SELECT i FROM c");
  d.close();
  const o = new Database(join(where, "other.db"));
  o.exec("CREATE TABLE extra (v TEXT)");
  o.exec("INSERT INTO extra VALUES ('from-other')");
  o.close();
}, 60_000);

afterAll(async () => {
  servers.stop();
  app.close();
  for (const [k, v] of [["FORGE_URL", env.url], ["FORGE_TOKEN", env.token]] as const)
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
});

async function run(who: string, argv: string[]) {
  process.env["FORGE_URL"] = servers.url;
  process.env["FORGE_TOKEN"] = token[who]!;
  const lines: string[] = [];
  const errs: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const werr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((s: string) => (lines.push(String(s)), true)) as never;
  process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as never;
  try {
    const code = await main(argv);
    return { code, text: lines.join(""), err: errs.join("") };
  } finally {
    process.stdout.write = write;
    process.stderr.write = werr;
  }
}

test("lists the databases a writer may read", async () => {
  const r = await run("alice", ["data"]);
  expect(r.code).toBe(EXIT.ok);
  expect(r.text).toContain("notes production app.db");
  expect((await run("bob", ["data", "--json"])).text.trim()).toBe("[]");
});

test("a table list, then rows with secrets masked", async () => {
  const t = await run("alice", ["data", "notes", "--json"]);
  expect(JSON.parse(t.text)).toEqual([{ name: "big", rows: 60 }, { name: "users", rows: 1 }]);
  const rows = await run("alice", ["data", "notes", "production", "--table", "users"]);
  expect(rows.text).toContain("ann-visible");
  expect(rows.text).not.toContain("tok-secret-1");
});

test("SQL prints JSON with --json, as objects", async () => {
  const r = await run("alice", ["data", "notes", "select id, name from users", "--json"]);
  expect(r.code).toBe(EXIT.ok);
  expect(JSON.parse(r.text)).toEqual([{ id: 1, name: "ann-visible" }]);
});

test("a write is refused, and a reader finds no such app", async () => {
  const w = await run("alice", ["data", "notes", "delete from users"]);
  expect(w.code).toBe(EXIT.failed);
  expect(w.err).toContain("Only SELECT and WITH statements are allowed.");
  const b = await run("bob", ["data", "notes", "select 1"]);
  expect(b.code).toBe(EXIT.usage);
});

test("--file picks another database of the environment; an unknown one is a usage error", async () => {
  const r = await run("alice", ["data", "notes", "--file", "other.db", "--table", "extra"]);
  expect(r.text).toContain("from-other");
  const none = await run("alice", ["data", "notes", "--file", "nope.db"]);
  expect(none.code).toBe(EXIT.usage);
});

test("an env argument names the environment; one that has no files is a usage error", async () => {
  expect((await run("alice", ["data", "notes", "production", "--json"])).code).toBe(EXIT.ok);
  expect((await run("alice", ["data", "notes", "pull-9"])).code).toBe(EXIT.usage);
});

test("--page turns the page; a bad one exits 2 before asking the forge", async () => {
  const one = JSON.parse((await run("alice", ["data", "notes", "--table", "big", "--page", "1", "--json"])).text);
  expect(one.length).toBe(10);
  expect(one[0]).toEqual({ id: 51 });
  for (const bad of [["--page", "x"], ["--page", "-1"], ["--page=-1"], ["--page", "1.5"], ["--page="], ["--page"]]) {
    const r = await run("alice", ["data", "notes", "--table", "big", ...bad]);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain("--page");
  }
});

test("--table with SQL is refused, not half-obeyed", async () => {
  const r = await run("alice", ["data", "notes", "select 1", "--table", "users"]);
  expect(r.code).toBe(EXIT.usage);
  expect(r.err).toContain("--table");
});

test("an unknown table is the forge's words, exit 1", async () => {
  const r = await run("alice", ["data", "notes", "--table", "nope"]);
  expect(r.code).toBe(EXIT.failed);
  expect(r.err).toContain("no such table");
});

test("SQL from the shell keeps the per-person budget: the 21st run in a minute is refused, exit 1", async () => {
  // owner1 runs no other SQL in this file, so its window starts empty.
  for (let i = 0; i < SQL_PER_MINUTE; i++) expect((await run("owner1", ["data", "notes", "select 1", "--json"])).code).toBe(EXIT.ok);
  const r = await run("owner1", ["data", "notes", "select 1"]);
  expect(r.code).toBe(EXIT.failed);
  expect(r.err).toMatch(/try again in \d+ s/);
  // Browsing a table is not SQL and stays open.
  expect((await run("owner1", ["data", "notes", "--table", "users"])).code).toBe(EXIT.ok);
});

test("not signed in exits 3", async () => {
  process.env["FORGE_URL"] = "";
  process.env["FORGE_TOKEN"] = "";
  const prev = process.env["FORGE_CONFIG_DIR"];
  process.env["FORGE_CONFIG_DIR"] = join(dir, "no-config");
  const errs: string[] = [];
  const werr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((x: string) => (errs.push(String(x)), true)) as never;
  try {
    expect(await main(["data"])).toBe(EXIT.notConfigured);
  } finally {
    process.stderr.write = werr;
    if (prev === undefined) delete process.env["FORGE_CONFIG_DIR"];
    else process.env["FORGE_CONFIG_DIR"] = prev;
  }
  expect(errs.join("")).toContain("forge login");
});

test("pick: several matches are named, not guessed", () => {
  const list = [
    { source: "1", label: "notes · production · a.db" },
    { source: "2", label: "notes · production · b.db" },
  ];
  const r = pick(list, "notes", undefined, undefined);
  expect(typeof r).toBe("string");
  expect(r).toContain("several databases match");
  expect(pick(list, "notes", undefined, "b.db")).toEqual(list[1]!);
});
