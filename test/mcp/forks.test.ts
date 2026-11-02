/** MCP `forks`: ahead and behind per fork, and a private fork a second caller cannot see is absent. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../../src/app.ts";
import { commitToBranch } from "../../src/actions/repos.ts";
import { createRepo, forkRepo as cloneRepo } from "../../src/core/repos.ts";
import { createToken } from "../../src/core/tokens.ts";
import { createUser } from "../../src/core/users.ts";
import { serve, type Servers } from "../../src/http/server.ts";
import { quietLogs } from "../helpers/globals.ts";

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
      params: { name: "forks", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-forks-mcp-"));
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
  const bob = ok(await make("bob"));
  const cy = ok(await make("cy"));
  const dee = ok(await make("dee"));
  const parent = ok(await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name: "svc", visibility: "public" }));
  ok(await commitToBranch(app, owner, parent, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  const ahead = ok(await cloneRepo(app.db, app.reposRoot, parent, bob.id, "svc"));
  const behind = ok(await cloneRepo(app.db, app.reposRoot, parent, cy.id, "svc"));
  const hidden = ok(await cloneRepo(app.db, app.reposRoot, parent, dee.id, "svc", { visibility: "private" }));
  ok(await commitToBranch(app, bob, ahead, { message: "mine", files: [{ path: "b.txt", content: "b\n" }] }));
  ok(await commitToBranch(app, owner, parent, { message: "more", files: [{ path: "c.txt", content: "c\n" }] }));
  void behind;
  void hidden;
  tok["ada"] = createToken(app.db, owner.id, "rw", "rw").token;
  tok["bob"] = createToken(app.db, bob.id, "rw", "rw").token;
  tok["dee"] = createToken(app.db, dee.id, "rw", "rw").token;
}, 30_000);

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("two forks: one ahead, one behind; the private one is absent for a second caller", async () => {
  const got = (await mcp(tok["ada"]!, { repo: "ada/svc" })).value;
  expect(got.parent).toBeNull();
  const by = Object.fromEntries(got.forks.map((f: any) => [f.repo, f]));
  expect(Object.keys(by).sort()).toEqual(["bob/svc", "cy/svc"]);
  expect(by["bob/svc"]).toMatchObject({ ahead: 1, behind: 1 });
  expect(by["cy/svc"]).toMatchObject({ ahead: 0, behind: 1 });
  expect(by["cy/svc"].updatedAt).toMatch(/^\d{4}-/);
});

test("the private fork's owner sees it, with its parent named", async () => {
  const got = (await mcp(tok["dee"]!, { repo: "ada/svc" })).value;
  expect(got.forks.map((f: any) => f.repo).sort()).toEqual(["bob/svc", "cy/svc", "dee/svc"]);
  const own = (await mcp(tok["dee"]!, { repo: "dee/svc" })).value;
  expect(own).toEqual({ parent: "ada/svc", forks: [] });
});
