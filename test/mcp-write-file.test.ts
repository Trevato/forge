/** MCP `write_file`: a writer commits one file and reads it back; a read-only token is refused in the dispatcher's words; a path with `..` is refused. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo, getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

async function call(token: string, name: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-write-file-mcp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const owner = ok(
    await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "ada",
      email: "ada@forge.local",
      password: "a-good-passphrase",
    }),
  );
  const repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "pub", visibility: "public" }));
  ok(await commitToBranch(app, owner, repo, { message: "seed", files: [{ path: "a.txt", content: "one\n" }] }));
  ok(await commitToBranch(app, owner, repo, { branch: "work", message: "branch", files: [{ path: "b.txt", content: "b\n" }] }));
  tok["rw"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["ro"] = createToken(app.db, owner.id, "ro", "ro").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

const args = (over: Record<string, unknown> = {}) => ({
  repo: "ada/pub",
  branch: "work",
  path: "notes/c.txt",
  content: "written\n",
  message: "add c",
  ...over,
});

test("a writer commits and read_file reads it back", async () => {
  const done = await call(tok["rw"]!, "write_file", args());
  expect(done.value.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(typeof done.value.says).toBe("string");
  const read = await call(tok["rw"]!, "read_file", { repo: "ada/pub", path: "notes/c.txt", ref: "work" });
  expect(read.value.content).toBe("written\n");
});

test("a read-only token is refused in the dispatcher's words", async () => {
  const r = await call(tok["ro"]!, "write_file", args({ path: "d.txt" }));
  expect(r.error).toBe("forbidden: this token may read, not act");
});

test("a path with .. is refused, and so is a branch that does not exist", async () => {
  const r = await call(tok["rw"]!, "write_file", args({ path: "../x.txt" }));
  expect(r.error).toBe("invalid_path: that path cannot be written; use a plain relative path with no .. or .git");
  expect((await call(tok["rw"]!, "write_file", args({ branch: "nope" }))).error).toContain("not_found");
});

test("commitToBranch refuses with branch_moved when the head is not the one expected, and does not recreate a deleted branch", async () => {
  const user = getUserByName(app.db, "ada")!;
  const repo = getRepo(app.db, "ada", "pub")!;
  const files = [{ path: "e.txt", content: "e\n" }];
  const stale = await commitToBranch(app, user, repo, { branch: "work", message: "m", files, expectTip: "0".repeat(40) });
  expect(!stale.ok && (stale.error as { kind: string }).kind).toBe("branch_moved");
  const gone = await commitToBranch(app, user, repo, { branch: "never-was", message: "m", files, expectTip: "0".repeat(40) });
  expect(!gone.ok && (gone.error as { kind: string }).kind).toBe("branch_moved");
});
