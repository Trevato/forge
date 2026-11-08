/** The API's and the MCP's search grep code within the page's budget; `code=all` lifts it (#6142). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve } from "../src/http/server.ts";

let dir = "";
let app: ReturnType<typeof createApp>;
let servers: Awaited<ReturnType<typeof serve>>;
let bearer = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-api-search-budget-"));
  // A spent budget: one batch of four greps runs, the other two repos wait.
  app = createApp({ dataDir: dir, port: 0, codeBudgetMs: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!made.ok) throw new Error(made.error);
  bearer = createToken(app.db, made.value.id, "t", "admin").token;
  const post = (path: string, body: unknown) =>
    fetch(servers.url + path, {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (let i = 0; i < 6; i++) {
    await post("/api/v1/repos", { name: `r${i}`, visibility: "public" });
    await post(`/api/v1/repos/alice/r${i}/contents`, {
      branch: "main", message: "c", files: [{ path: "a.txt", content: "narwhalword\n" }],
    });
  }
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const api = async (qs: string) =>
  (await (await fetch(`${servers.url}/api/v1/search?${qs}`)).json()) as any;

test("the API stops starting greps at the budget and says moreCode", async () => {
  const cut = await api("q=narwhalword&kind=code");
  expect(cut.moreCode).toBe(true);
  expect(cut.code.length).toBe(4);
});

test("code=all lifts the budget, as on the page", async () => {
  const all = await api("q=narwhalword&kind=code&code=all");
  expect(all.moreCode).toBe(false);
  expect(all.code.length).toBe(6);
});

const mcp = async (args: Record<string, unknown>) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search", arguments: { q: "narwhalword", kind: "code", ...args } },
    }),
  });
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text);
};

test("MCP search takes the same path", async () => {
  const found = await mcp({});
  expect(found.moreCode).toBe(true);
  expect(found.code.length).toBe(4);
});

test("MCP search with all greps the rest", async () => {
  const found = await mcp({ all: true });
  expect(found.moreCode).toBe(false);
  expect(found.code.length).toBe(6);
});
