/** crew, health and capacity, called through `tools/call`, carry their card: the tool wiring, not only the card model. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-crew-tool-cards-"));
  app = createApp({ dataDir, port: 0 });
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  const alice = getUserByName(app.db, "alice")!;
  token = createToken(app.db, alice.id, "admin", "admin").token;
  servers = await serve(app);
  const repo = await createRepo(app, alice, { name: "engine", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  return ((await res.json()) as any).result;
};

test("crew {repo}: the card names the repo and links to its crew settings", async () => {
  const r = await call("crew", { repo: "alice/engine" });
  const card = r.structuredContent.card;
  expect(card.kind).toBe("crew");
  expect(card.status).toContain("of alice/engine");
  expect(card.rows.length).toBeGreaterThan(0);
  for (const row of card.rows) expect(row.link).toBe(`${servers.url}/alice/engine/settings/crew`);
});

test("health: a card with the version in its status", async () => {
  const r = await call("health", {});
  expect(r.structuredContent.card.kind).toBe("health");
  expect(r.structuredContent.card.status).toMatch(/^(green|red)/);
});

test("capacity: a card with a linked row per setting", async () => {
  const r = await call("capacity", {});
  const card = r.structuredContent.card;
  expect(card.kind).toBe("capacity");
  expect(card.rows.length).toBeGreaterThan(0);
  expect(card.rows[0].link).toBe(`${servers.url}/settings/capacity`);
});
