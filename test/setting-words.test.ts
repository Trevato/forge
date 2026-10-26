/**
 * A setting's refusals read the same from every door (#5563): a capacity
 * value out of range, and an app's people asked for by someone who does not
 * write the repository. The API and the MCP tool each answer the sentence
 * src/actions/setting_words.ts holds, so a door that retypes it fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { SETTING_WORDS } from "../src/actions/setting_words.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { Glob } from "bun";
import { mcpTool } from "./helpers/mcp.ts";

describe("a setting's refusals come from one module", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceAdmin: string;
  let bobAdmin: string;

  const person = async (username: string): Promise<User> => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  const api = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${servers.url}/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-setting-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const alice = await person("alice");
    const bob = await person("bob");
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    aliceAdmin = createToken(app.db, alice.id, "t", "admin").token;
    bobAdmin = createToken(app.db, bob.id, "t", "admin").token;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a capacity value out of range: the API and MCP answer the module's sentence", async () => {
    const res = await api(aliceAdmin, "PUT", "/admin/capacity/checks.concurrency", { value: "0" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).message).toBe(SETTING_WORDS.outOfRange);
    const tool = await mcpTool(servers.url, aliceAdmin, "capacity", {
      key: "checks.concurrency",
      value: "0",
      dryRun: false,
    });
    expect(tool.error).toContain(SETTING_WORDS.outOfRange);
  });

  test("an app's people asked for by a non-writer: the API and MCP answer the module's sentence", async () => {
    const res = await api(bobAdmin, "GET", "/repos/alice/garden/app/members");
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).message).toBe(SETTING_WORDS.appMembersForbidden);
    const tool = await mcpTool(servers.url, bobAdmin, "app_members", { repo: "alice/garden" });
    expect(tool.error).toContain(SETTING_WORDS.appMembersForbidden);
  });

  test("no file under src/ but the module types these sentences out", async () => {
    const typed: string[] = [];
    for await (const path of new Glob("src/**/*.ts").scan(".")) {
      if (path.replaceAll("\\", "/") === "src/actions/setting_words.ts") continue;
      const text = await readFile(path, "utf8");
      for (const words of Object.values(SETTING_WORDS))
        if (text.includes(words)) typed.push(`${path}: ${words}`);
    }
    expect(typed).toEqual([]);
  });
});
