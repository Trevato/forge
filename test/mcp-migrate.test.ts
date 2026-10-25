/**
 * The MCP `migrate` tool: `url` starts the same migration `POST
 * /api/v1/migrate` does and answers {job, state, url}; `job` alone reads it.
 * A private address is refused as the route refuses it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { settled } from "../src/origins/jobs.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let open: App; // may clone from loopback: the fixture lives on it
let shut: App; // the default: private addresses are refused
let openServer: Servers;
let shutServer: Servers;
const tokens = new Map<string, string>();
let aliceId = "";

async function setup(app: App, username = "alice", adminIfFirst = true) {
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.local`,
    password: "a-good-passphrase",
    adminIfFirst,
  });
  if (!made.ok) throw new Error(made.error);
  return { user: made.value, token: createToken(app.db, made.value.id, "rw", "rw").token };
}

async function migrate(
  servers: Servers,
  token: string,
  args: unknown,
): Promise<{ error?: string; value?: any }> {
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
      params: { name: "migrate", arguments: args },
    }),
  });
  const body = (await res.json()) as any;
  const text: string = body.result.content[0].text;
  return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-migrate-"));
  open = createApp({ dataDir: join(dir, "open"), port: 0, migrateFromPrivateHosts: true });
  openServer = await serve(open);
  const alice = await setup(open);
  tokens.set("open", alice.token);
  aliceId = alice.user.id;
  shut = createApp({ dataDir: join(dir, "shut"), port: 0 });
  shutServer = await serve(shut);
  await setup(shut); // the first account is an admin, who may reach private hosts
  tokens.set("shut", (await setup(shut, "bob", false)).token);

  const made = await createRepo(open, alice.user, { name: "fixture", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const c = await commitToBranch(open, alice.user, made.value, {
    branch: "main",
    message: "Start",
    files: [{ path: "README.md", content: "hello\n" }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
}, 30_000);

afterAll(async () => {
  openServer.stop();
  shutServer.stop();
  open.close();
  shut.close();
  await rm(dir, { recursive: true, force: true });
});

test("a url migrates a fixture, and the job reads until it is done", async () => {
  const tok = tokens.get("open")!;
  const started = await migrate(openServer, tok, {
    url: `http://127.0.0.1:${openServer.port}/alice/fixture.git`,
    name: "copy",
  });
  expect(started.error).toBeUndefined();
  expect(started.value.url).toBe(`${openServer.url}/alice/copy`);
  expect(typeof started.value.job).toBe("string");
  await settled(started.value.job);
  const read = await migrate(openServer, tok, { job: started.value.job });
  expect(read.value.state).toBe("done");
  expect(read.value.url).toBe(`${openServer.url}/alice/copy`);
  expect(read.value.error).toBeNull();
});

test("a job nobody started is not found, and no argument is told what to send", async () => {
  const tok = tokens.get("open")!;
  expect((await migrate(openServer, tok, { job: "nope" })).error).toContain("no such migration");
  expect((await migrate(openServer, tok, {})).error).toContain("`url`");
});

test("a private-address url is refused as the route refuses it", async () => {
  const tok = tokens.get("shut")!;
  const res = await migrate(shutServer, tok, {
    url: `http://127.0.0.1:${shutServer.port}/alice/fixture.git`,
  });
  expect(res).toEqual({ error: expect.stringContaining("private") });
  const route = await fetch(`${shutServer.url}/api/v1/migrate`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ source: { url: `http://127.0.0.1:${shutServer.port}/alice/fixture.git` } }),
  });
  expect(route.status).toBe(422);
  expect(((await route.json()) as any).error).toBe("private_host");
});

test("a read-only token reads a job but cannot start a migration", async () => {
  const rw = tokens.get("open")!;
  const ro = createToken(open.db, aliceId, "ro", "ro").token;
  const url = `http://127.0.0.1:${openServer.port}/alice/fixture.git`;
  const refused = await migrate(openServer, ro, { url, name: "sneaky" });
  expect(refused.error).toContain("this token may read, not act");
  const route = await fetch(`${openServer.url}/api/v1/repos/alice/sneaky`, {
    headers: { authorization: `Bearer ${rw}` },
  });
  expect(route.status).toBe(404);
  const started = await migrate(openServer, rw, { url, name: "readable" });
  await settled(started.value.job);
  const read = await migrate(openServer, ro, { job: started.value.job });
  expect(read.error).toBeUndefined();
  expect(read.value.state).toBe("done");
});

test("an unknown crew agent is refused", async () => {
  const res = await migrate(openServer, tokens.get("open")!, {
    url: `http://127.0.0.1:${openServer.port}/alice/fixture.git`,
    name: "crewed",
    crew: "no-such-agent-here",
  });
  expect(res.error).toBeDefined();
});
