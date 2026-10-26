/** MCP `branches` with `kind: "tags"`: newest first, a private repository is not found to a stranger, and misuse is refused. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { runGit } from "../src/git/env.ts";
import { repoDir } from "../src/git/repos.ts";
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

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tags-mcp-"));
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
  const stranger = ok(await make("sam"));
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" }));
  const priv = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "vault", visibility: "private" }));
  for (const repo of [pub, priv]) {
    ok(await commitToBranch(app, owner, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
    const dir = repoDir(app.reposRoot, owner.username, repo.name);
    const env = {
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
    };
    // Alphabetical order is the reverse of age, so sorting by name cannot pass.
    for (const [name, date] of [["v3", "2020-01-01T00:00:00Z"], ["v2", "2021-01-01T00:00:00Z"], ["v1", "2022-01-01T00:00:00Z"]] as const)
      ok(await runGit(["tag", "-a", name, "-m", name, "main"], { cwd: dir, env: { ...env, GIT_COMMITTER_DATE: date } }));
  }
  tok["owner"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["stranger"] = createToken(app.db, stranger.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("tags are listed newest first", async () => {
  const got = (await mcp(tok["stranger"]!, { repo: "ada/svc", kind: "tags" })).value;
  expect(got.tags.map((t: any) => t.name)).toEqual(["v1", "v2", "v3"]);
  expect(got.tags[0].commit).toMatch(/^[0-9a-f]{40}$/);
  expect(got.tags[0].oid).not.toBe(got.tags[0].commit);
});

test("a private repository's tags are not found for a stranger", async () => {
  expect((await mcp(tok["stranger"]!, { repo: "ada/vault", kind: "tags" })).error).toContain("not_found");
  expect((await mcp(tok["owner"]!, { repo: "ada/vault", kind: "tags" })).value.tags).toHaveLength(3);
});

test("kind tags with name or action, and an unknown kind, are refused", async () => {
  const w = tok["owner"]!;
  expect((await mcp(w, { repo: "ada/svc", kind: "tags", name: "v1" })).error).toContain("only lists");
  expect((await mcp(w, { repo: "ada/svc", kind: "tags", action: "delete" })).error).toContain("only lists");
  expect((await mcp(w, { repo: "ada/svc", kind: "refs" })).error).toContain("branches or tags");
  expect((await mcp(w, { repo: "ada/svc", kind: "branches" })).value.branches[0].name).toBe("main");
});
