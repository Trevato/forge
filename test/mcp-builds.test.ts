/** MCP `builds`: the same pins as GET …/builds, read-only, and a private repository is not found to a stranger. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
const tok: Record<string, string> = {};

async function mcp(token: string, args: unknown): Promise<{ error?: string; value?: any }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "builds", arguments: args } }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-builds-mcp-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const make = async (username: string) => {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const ada = await make("ada");
  const sam = await make("sam");
  promote(app.db, sam);
  for (const [name, visibility] of [["game", "public"], ["vault", "private"]] as const) {
    const made = await createRepo(app, ada, { name, visibility });
    if (!made.ok) throw new Error(String(made.error));
    const c = await commitToBranch(app, ada, getRepo(app.db, "ada", name)!, { message: "one", files: [{ path: "a.txt", content: "a\n" }] });
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const pinned = await pinBuild(app, ada, getRepo(app.db, "ada", name)!, { label: "v1", oid: c.value.commitOid, note: "first", source: "branch main" });
    if (!pinned.ok) throw new Error(String(pinned.error));
  }
  tok["ada"] = createToken(app.db, ada.id, "rw", "rw").token;
  tok["sam"] = createToken(app.db, sam.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the tool answers the rows the API route lists", async () => {
  const api = await fetch(`${servers.url}/api/v1/repos/ada/game/builds`, { headers: { authorization: `Bearer ${tok["sam"]}` } });
  const expected = (await api.json()) as any;
  expect(expected.items).toHaveLength(1);
  expect(expected.items[0].label).toBe("v1");
  expect(expected.items[0].pinnedBy).toBe("ada");
  const got = await mcp(tok["sam"]!, { repo: "ada/game" });
  expect(got.value).toEqual(expected);
  expect(got.value.next_cursor).toBeNull();
});

test("a private repository is not found to a caller who cannot read it, and names no pin", async () => {
  const refused = await mcp(tok["sam"]!, { repo: "ada/vault" });
  expect(refused.error).toContain("not_found");
  expect(refused.error).not.toContain("v1");
  expect((await mcp(tok["ada"]!, { repo: "ada/vault" })).value.items).toHaveLength(1);
});
