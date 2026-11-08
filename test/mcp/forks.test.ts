/** MCP `forks`: ahead and behind per fork, and a private fork a second caller cannot see is absent. */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as drift from "../../src/actions/forks.ts";
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
  expect(own).toEqual({ parent: "ada/svc", forks: [], next_cursor: null });
});

test("pages by limit and cursor in the forks page's order, reading drift for the page only", async () => {
  const many = ok(await createUser(app.db, { origin: "seed", trusted: true, username: "many", email: "many@forge.local", password: "a-good-passphrase" }));
  const root = ok(await createRepo(app.db, app.reposRoot, { ownerId: many.id, name: "hub", visibility: "public" }));
  ok(await commitToBranch(app, many, root, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  for (let i = 0; i < 5; i++) {
    const u = ok(await createUser(app.db, { origin: "seed", trusted: true, username: `f${i}`, email: `f${i}@forge.local`, password: "a-good-passphrase" }));
    ok(await cloneRepo(app.db, app.reposRoot, root, u.id, "hub"));
  }
  const t = createToken(app.db, many.id, "rw", "rw").token;
  const http = await fetch(`${servers.url}/api/v1/repos/many/hub/forks?limit=200`, { headers: { authorization: `Bearer ${t}` } });
  const order: string[] = ((await http.json()) as any).items.map((f: any) => `${f.ownerName}/${f.name}`);
  expect(order.length).toBe(5);

  const spy = spyOn(drift, "driftOfForks");
  try {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      spy.mockClear();
      const got: any = (await mcp(t, { repo: "many/hub", limit: 2, ...(cursor === null ? {} : { cursor }) })).value;
      expect(got.forks.length).toBeLessThanOrEqual(2);
      const read = spy.mock.calls.reduce((n, c) => n + (c[2] as unknown[]).length, 0);
      expect(read).toBe(got.forks.length);
      seen.push(...got.forks.map((f: any) => f.repo));
      cursor = got.next_cursor;
      pages++;
    } while (cursor !== null);
    expect(pages).toBe(3);
    expect(seen).toEqual(order);
  } finally {
    spy.mockRestore();
  }
  expect((await mcp(t, { repo: "many/hub", cursor: "nope" })).error).toContain("cursor");
  expect((await mcp(t, { repo: "many/hub", limit: 0 })).error).toContain("limit");
});
