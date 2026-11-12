/**
 * A spend window or budget out of range reads the same from every door
 * (#5559): the API and MCP both answer the sentence src/actions/spend_words.ts
 * holds, and no other file under src/ types it out.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { SPEND_WORDS } from "../src/actions/spend_words.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let admin = "";
let id = 1;

const api = async (path: string, payload: unknown) => {
  const res = await fetch(`${servers.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as { error: string; message: string } };
};

const tool = async (name: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${admin}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
  });
  const body = (await res.json()) as any;
  return { error: body.result.isError === true, text: body.result.content[0].text as string };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-spend-words-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.dev", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  admin = createToken(app.db, a.value.id, "admin", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a grant out of range answers the module's sentence from the API and MCP", async () => {
  const viaApi = await api("/api/v1/admin/accounts/bob/model-grant", { usdPerMonth: 20000 });
  expect(viaApi).toMatchObject({ status: 422, body: { error: "invalid", message: SPEND_WORDS.usdPerMonth } });
  const viaMcp = await tool("model_grant", { username: "bob", usdPerMonth: 20000, dryRun: false });
  expect(viaMcp).toMatchObject({ error: true, text: `invalid: ${SPEND_WORDS.usdPerMonth}` });
});

test("a role's allowance out of range answers the module's sentence from the API and MCP", async () => {
  const viaApi = await api("/api/v1/admin/accounts/bob/role", { role: "member", usdPerMonth: 20000 });
  expect(viaApi).toMatchObject({ status: 422, body: { error: "invalid", message: SPEND_WORDS.usdPerMonth } });
  const viaMcp = await tool("account_role", { username: "bob", role: "member", usdPerMonth: 20000, dryRun: false });
  expect(viaMcp).toMatchObject({ error: true, text: `invalid: ${SPEND_WORDS.usdPerMonth}` });
});

test("a ceiling out of range answers the module's sentence from the API and MCP", async () => {
  const viaApi = await api("/api/v1/admin/accounts/bob/ceiling", { dailyUsd: 20000, perRunUsd: 1 });
  expect(viaApi).toMatchObject({ status: 422, body: { error: "invalid", message: SPEND_WORDS.ceilings } });
  const viaMcp = await tool("model_ceiling", { username: "bob", dailyUsd: 20000, perRunUsd: 1, dryRun: false });
  expect(viaMcp).toMatchObject({ error: true, text: `invalid: ${SPEND_WORDS.ceilings}` });
});

test("an invite's days out of range answers the module's sentence from the API and MCP", async () => {
  const viaApi = await api("/api/v1/admin/invites", { days: 31 });
  expect(viaApi).toMatchObject({ status: 422, body: { error: "invalid", message: SPEND_WORDS.inviteDays } });
  const viaMcp = await tool("mint_invite", { days: 31 });
  expect(viaMcp).toMatchObject({ error: true, text: `invalid: ${SPEND_WORDS.inviteDays}` });
});

test("no file under src/ but the module types the sentences out", async () => {
  const root = join(import.meta.dir, "..", "src");
  const files = (await readdir(root, { recursive: true })).filter((f) => f.endsWith(".ts"));
  const retyped: string[] = [];
  for (const file of files) {
    if (file === join("actions", "spend_words.ts")) continue;
    const text = await readFile(join(root, file), "utf8");
    for (const sentence of Object.values(SPEND_WORDS)) if (text.includes(sentence)) retyped.push(`${file}: ${sentence}`);
  }
  expect(retyped).toEqual([]);
});
