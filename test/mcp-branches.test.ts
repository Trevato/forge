/** MCP `branches`: a writer lists, creates and deletes; a reader is refused with the page's words; bad input stops at the boundary. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { CREATE_ERRORS } from "../src/web/pages/branches.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
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

async function mcp(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "branches", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

const names = async (): Promise<string[]> =>
  ((await mcp(tok["writer"]!, { repo: "ada/svc" })).value.branches as { name: string }[]).map((b) => b.name);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-branches-mcp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = (username: string) =>
    createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
    });
  const owner = ok(await make("ada"));
  const reader = ok(await make("rita"));
  const repo = ok(
    await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" }),
  );
  ok(await commitToBranch(app, owner, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  tok["writer"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["writerRo"] = createToken(app.db, owner.id, "ro", "ro").token;
  tok["reader"] = createToken(app.db, reader.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a writer lists, creates and deletes a branch", async () => {
  const w = tok["writer"]!;
  const first = (await mcp(w, { repo: "ada/svc" })).value;
  expect(first.url).toBe("/ada/svc/branches");
  expect(first.branches.map((b: any) => b.name)).toEqual(["main"]);

  const made = await mcp(w, { repo: "ada/svc", name: "feature", action: "create" });
  expect(made.value.says).toStartWith("Created feature at ");
  expect(await names()).toContain("feature");
  expect((await mcp(w, { repo: "ada/svc", name: "feature", action: "create" })).error).toContain(
    CREATE_ERRORS["exists"]!,
  );

  const gone = await mcp(w, { repo: "ada/svc", name: "feature", action: "delete" });
  expect(gone.value.says).toBe("Deleted feature.");
  expect(await names()).not.toContain("feature");
});

test("the default branch is never deleted", async () => {
  const refused = await mcp(tok["writer"]!, { repo: "ada/svc", name: "main", action: "delete" });
  expect(refused.error).toContain("default branch cannot be deleted");
  expect(await names()).toContain("main");
});

test("a reader is refused with the page's words, and a read-only token cannot act", async () => {
  const tried = await mcp(tok["reader"]!, { repo: "ada/svc", name: "sneaky", action: "create" });
  expect(tried.error).toContain("You need write access to create a branch.");
  expect(await names()).not.toContain("sneaky");
  const ro = await mcp(tok["writerRo"]!, { repo: "ada/svc", name: "sneaky", action: "create" });
  expect(ro.error).toContain("forbidden");
  expect(await names()).not.toContain("sneaky");
});

test("bad input is refused at the boundary", async () => {
  const w = tok["writer"]!;
  expect((await mcp(w, { repo: "ada/svc", name: "x" })).error).toContain("create or delete");
  expect((await mcp(w, { repo: "ada/svc", name: 7, action: "create" })).error).toContain("invalid");
  expect((await mcp(w, { repo: "ada/svc", name: "a b", action: "create" })).error).toContain(
    CREATE_ERRORS["invalid_name"]!,
  );
  expect((await mcp(w, { repo: "ada/svc", name: "y", action: "create", from: 5 })).error).toContain("invalid");
  expect((await mcp(w, { repo: "nope/none" })).error).toContain("not_found");
});
