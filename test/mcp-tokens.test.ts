/**
 * The `tokens` tool lists the caller's own API tokens and nobody else's,
 * never a secret or a hash.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { createUser } from "../src/core/users.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let id = 1;
const mine: { token: string; name: string }[] = [];
let bobToken = "";

const rpc = async (token: string, method: string, params: unknown = {}) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  return (await res.json()) as any;
};
const tokens = async (token: string) => {
  const body = await rpc(token, "tools/call", { name: "tokens", arguments: {} });
  const text: string = body.result.content[0].text;
  return { text, value: JSON.parse(text) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-tokens-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await seedAdmin(app, { username: "olive", email: "o@f.dev", password: "owner-passphrase" });
  if (!a.ok) throw new Error(a.error);
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "b@f.dev", password: "a-good-passphrase" });
  if (!b.ok) throw new Error(b.error);
  promote(app.db, b.value);
  mine.push({ ...createToken(app.db, a.value.id, "laptop", "rw"), name: "laptop" });
  mine.push({ ...createToken(app.db, a.value.id, "reader", "ro"), name: "reader" });
  bobToken = createToken(app.db, b.value.id, "bobs-secret-name", "ro").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a person sees both their tokens, and no secret", async () => {
  const got = await tokens(mine[0]!.token);
  expect(got.value.items.map((t: { name: string }) => t.name).sort()).toEqual(["laptop", "reader"]);
  expect(got.value.items[0]).toHaveProperty("scope");
  expect(got.value.items[0]).toHaveProperty("createdAt");
  for (const t of mine) expect(got.text).not.toContain(t.token);
  expect(got.text).not.toMatch(/hash/i);
});

test("another person's tokens are never listed", async () => {
  const got = await tokens(mine[0]!.token);
  expect(got.text).not.toContain("bobs-secret-name");
  expect(got.text).not.toContain(bobToken);
  const bob = await tokens(bobToken);
  expect(bob.value.items.map((t: { name: string }) => t.name)).toEqual(["bobs-secret-name"]);
});

test("tools/list marks it read-only", async () => {
  const body = await listVia((p) => rpc(mine[0]!.token, "tools/list", p));
  const t = body.result.tools.find((x: { name: string }) => x.name === "tokens");
  expect(t.annotations.readOnlyHint).toBe(true);
});
