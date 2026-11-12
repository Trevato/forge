/** The API and MCP explore rows carry the same `why` line the page shows (#11422); absent when the ranking has nothing to say. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let token = "";
type Item = { kind: string; name: string; why?: string };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-explore-why-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const founder = await createUser(app.db, { origin: "seed", trusted: true, username: "founder", email: "f@x.test", password: "a-long-words-passphrase", adminIfFirst: true });
  if (!founder.ok) throw new Error("founder");
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-words-passphrase" });
  if (!made.ok) throw new Error("user");
  promote(app.db, made.value);
  const alice = getUserByName(app.db, "alice")!;
  for (const name of ["loved", "quiet"]) {
    const repo = await createRepo(app, alice, { name, visibility: "public" });
    if (!repo.ok) throw new Error("repo");
    const rec = insertApp(app.db, { repoId: repo.value.id, slug: `alice-${name}`, access: "public" });
    if (!rec.ok) throw new Error("app");
    if (name === "loved")
      for (let i = 0; i < 2; i++)
        app.db.run("INSERT INTO feed_like (viewer_id, item_id, repo_id) VALUES (?1, ?2, ?3)", [alice.id, `p-${i}`, repo.value.id]);
  }
  token = createToken(app.db, alice.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const headers = () => ({ authorization: `Bearer ${token}` });

test("the MCP explore row says why, and a row with nothing to say has no why", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers() },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: { q: "kind:app sort:likes" } } }),
  });
  const items = (JSON.parse(((await res.json()) as any).result.content[0].text) as { items: Item[] }).items;
  expect(items.find((i) => i.name.endsWith("loved"))?.why).toBe("2 likes");
  const quiet = items.find((i) => i.name.endsWith("quiet"));
  expect(quiet).toBeDefined();
  expect("why" in quiet!).toBe(false);
});

test("the API explore row says the same", async () => {
  const res = await fetch(`${servers.url}/api/v1/explore?q=${encodeURIComponent("kind:app sort:likes")}`, { headers: headers() });
  const items = ((await res.json()) as { items: Item[] }).items;
  expect(items.find((i) => i.name.endsWith("loved"))?.why).toBe("2 likes");
  expect("why" in items.find((i) => i.name.endsWith("quiet"))!).toBe(false);
});
