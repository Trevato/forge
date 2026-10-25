/** MCP `commits`: a good answer, a private repository is not found to a stranger, and bad arguments are refused. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch } from "../src/actions/repos.ts";
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
      params: { name: "commits", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-commits-mcp-"));
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
  const stranger = ok(await make("rita"));
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" }));
  const priv = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "secret", visibility: "private" }));
  for (const repo of [pub, priv]) {
    ok(await commitToBranch(app, owner, repo, { message: "first", files: [{ path: "a.txt", content: "a\n" }] }));
    ok(await commitToBranch(app, owner, repo, { message: "second", files: [{ path: "b.txt", content: "b\n" }] }));
  }
  ok(
    await commitToBranch(app, owner, pub, {
      branch: "feature",
      message: "on feature",
      files: [{ path: "c.txt", content: "c\n" }],
    }),
  );
  tok["owner"] = createToken(app.db, owner.id, "ro", "ro").token;
  tok["stranger"] = createToken(app.db, stranger.id, "ro", "ro").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("lists the newest commits first, and honours limit", async () => {
  const all = (await mcp(tok["owner"]!, { repo: "ada/svc" })).value.commits;
  expect(all.map((c: any) => c.subject)).toEqual(["second", "first"]);
  const one = (await mcp(tok["stranger"]!, { repo: "ada/svc", limit: 1 })).value.commits;
  expect(one.length).toBe(1);
});

test("ref picks the branch, and a ref that does not exist answers no commits", async () => {
  const o = tok["owner"]!;
  const feature = (await mcp(o, { repo: "ada/svc", ref: "feature" })).value.commits;
  expect(feature.map((c: any) => c.subject)).toEqual(["on feature", "second", "first"]);
  const main = (await mcp(o, { repo: "ada/svc" })).value.commits;
  expect(main.map((c: any) => c.subject)).not.toContain("on feature");
  expect((await mcp(o, { repo: "ada/svc", ref: "nope" })).value).toEqual({ commits: [] });
});

test("a private repository is not found to someone who cannot read it", async () => {
  expect((await mcp(tok["owner"]!, { repo: "ada/secret" })).value.commits.length).toBe(2);
  const r = await mcp(tok["stranger"]!, { repo: "ada/secret" });
  expect(r.error).toContain("not_found");
  expect(r.value).toBeUndefined();
});

test("bad arguments are refused", async () => {
  const o = tok["owner"]!;
  expect((await mcp(o, { repo: "ada/svc", limit: 0 })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", limit: 101 })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", limit: "5" })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", ref: "--upload-pack=x" })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", ref: 7 })).error).toContain("invalid");
});

test("oid opens one commit with its files changed and its check", async () => {
  const [head] = (await mcp(tok["owner"]!, { repo: "ada/svc" })).value.commits;
  const r = (await mcp(tok["stranger"]!, { repo: "ada/svc", oid: head.oid.slice(0, 8) })).value;
  expect(r.oid).toBe(head.oid);
  expect(r.says).toContain("second");
  expect(r.diff.files.length).toBe(1);
  expect(r.check).toBeTruthy();
});

test("oid: a bad or unknown one is refused, and a private repository stays hidden", async () => {
  const o = tok["owner"]!;
  expect((await mcp(o, { repo: "ada/svc", oid: "xyz" })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", oid: "--all" })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", oid: 5 })).error).toContain("invalid");
  expect((await mcp(o, { repo: "ada/svc", oid: "deadbeef" })).error).toContain("not_found");
  const [head] = (await mcp(o, { repo: "ada/secret" })).value.commits;
  expect((await mcp(tok["stranger"]!, { repo: "ada/secret", oid: head.oid })).error).toContain("not_found");
});
