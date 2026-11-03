/** GET /api/v1/agents and /agents/:username carry a weak ETag and answer a repeat with 304 until an agent changes (#9277). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App, servers: Servers;
const tok: Record<string, string> = {};
const call = (method: string, path: string, token: string, extra: Record<string, string> = {}, body?: unknown) =>
  fetch(`${servers.url}/api/v1/${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}), ...extra },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
const tagOf = async (path: string, token = tok["admin"]!) => {
  const r = await call("GET", path, token);
  expect(r.status).toBe(200);
  await r.text();
  return r.headers.get("etag")!;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-agents-etag-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string, first: boolean) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const ada = await mk("ada", true);
  const bob = await mk("bob", false);
  tok["admin"] = createToken(app.db, ada.id, "a", "admin").token;
  tok["bob"] = createToken(app.db, bob.id, "b", "admin").token;
});

afterAll(async () => {
  servers?.stop();
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a repeat is 304; every write moves the tag; another viewer's tag does not match", async () => {
  const made = await call("POST", "agents", tok["admin"]!, {}, { username: "bot", brief: "one" });
  expect(made.status).toBe(201);
  for (const path of ["agents", "agents/bot"]) {
    const r = await call("GET", path, tok["admin"]!);
    const tag = r.headers.get("etag")!;
    expect(tag).toMatch(/^W\//);
    expect(r.headers.get("cache-control")).toBe("private");
    expect(r.headers.get("vary")).toContain("authorization, cookie");
    const again = await call("GET", path, tok["admin"]!, { "if-none-match": tag });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("vary")).toContain("authorization, cookie");
    const other = await call("GET", path, tok["bob"]!, { "if-none-match": tag });
    expect(other.status).toBe(200);
    expect(other.headers.get("etag")).not.toBe(tag);
  }
  const listTag = await tagOf("agents");
  const oneTag = await tagOf("agents/bot");
  expect((await call("PATCH", "agents/bot", tok["admin"]!, {}, { brief: "two" })).status).toBe(200);
  const stale = await call("GET", "agents/bot", tok["admin"]!, { "if-none-match": oneTag });
  expect(stale.status).toBe(200);
  expect(stale.headers.get("etag")).not.toBe(oneTag);
  expect((await call("GET", "agents", tok["admin"]!, { "if-none-match": listTag })).status).toBe(200);

  const afterPatch = await tagOf("agents");
  expect((await call("POST", "agents", tok["admin"]!, {}, { username: "bot2" })).status).toBe(201);
  expect(await tagOf("agents")).not.toBe(afterPatch);
  const afterPost = await tagOf("agents");
  expect((await call("DELETE", "agents/bot2", tok["admin"]!)).status).toBe(200);
  expect(await tagOf("agents")).not.toBe(afterPost);
});
