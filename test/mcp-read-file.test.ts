/** MCP `read_file`: a file or a directory at a ref, as GET …/contents answers; a private repository is not found; bad arguments are refused. */
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

async function read(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
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
      params: { name: "read_file", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-read-file-mcp-"));
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
  const pub = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "pub", visibility: "public" }));
  const priv = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "priv", visibility: "private" }));
  for (const r of [pub, priv])
    ok(await commitToBranch(app, owner, r, { message: "seed", files: [{ path: "src/a.txt", content: "hello\n" }] }));
  tok["owner"] = createToken(app.db, owner.id, "o", "ro").token;
  tok["stranger"] = createToken(app.db, stranger.id, "s", "ro").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a file and a directory are answered as the contents route does", async () => {
  const file = (await read(tok["stranger"]!, { repo: "ada/pub", path: "src/a.txt" })).value;
  expect(file).toMatchObject({ type: "file", path: "src/a.txt", encoding: "utf-8", content: "hello\n", size: 6 });
  const dir = (await read(tok["stranger"]!, { repo: "ada/pub", path: "src", ref: "main" })).value;
  expect(dir.type).toBe("dir");
  expect(JSON.stringify(dir.entries)).toContain("a.txt");
  expect((await read(tok["stranger"]!, { repo: "ada/pub", path: "" })).value.type).toBe("dir");
});

test("a private repository is not found to a caller who cannot read it", async () => {
  expect((await read(tok["owner"]!, { repo: "ada/priv", path: "src/a.txt" })).value.content).toBe("hello\n");
  expect((await read(tok["stranger"]!, { repo: "ada/priv", path: "src/a.txt" })).error).toContain("not_found");
});

test("bad arguments are refused", async () => {
  const t = tok["owner"]!;
  expect((await read(t, { repo: "ada/pub", path: "../etc/passwd" })).error).toContain("not_found");
  expect((await read(t, { repo: "ada/pub", path: "src/a.txt", ref: "--upload-pack=x" })).error).toContain("not_found");
  expect((await read(t, { repo: "ada/pub", path: 7 })).error).toContain("invalid");
  expect((await read(t, { repo: "ada/pub", path: "nope.txt" })).error).toContain("not_found");
});
