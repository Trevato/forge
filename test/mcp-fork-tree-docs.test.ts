/**
 * The fork-tree MCP tools say in `doc` what they take and what they answer
 * (#9109): read live from `tools/list` and a sample call, so a changed answer
 * that the doc forgets fails here.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { tool as family } from "../src/http/mcp/tools/family.ts";
import { tool as follow_mode } from "../src/http/mcp/tools/follow_mode.ts";
import { tool as following } from "../src/http/mcp/tools/following.ts";
import { tool as forks } from "../src/http/mcp/tools/forks.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listAt } from "./mcp-list.ts";

quietLogs();

describe("fork-tree MCP tool docs", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let token = "";
  // `doc` is never sent to a client (it is the /llms.txt line), so it is read from the tool.
  const docs: Record<string, string> = Object.fromEntries([forks, following, follow_mode, family].map((t) => [t.name, t.doc ?? ""]));
  const schemas: Record<string, Record<string, unknown>> = {};

  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    // A refusal is `code: message`, not JSON.
    return body.result.isError === true ? { error: text.split(":")[0] } : (JSON.parse(text) as Record<string, unknown>);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-treedocs-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "a-long-treedocs-pass", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    token = createToken(app.db, alice.id, "t", "admin").token;
    const lib = await createRepo(app, alice, { name: "lib", visibility: "public" });
    if (!lib.ok) throw new Error("lib");
    const fork = await forkRepo(app, alice, lib.value, "lib-fork");
    if (!fork.ok) throw new Error("fork");
    const listed = (await listAt(servers.url, token)).result.tools;
    for (const t of listed) {
      schemas[t.name] = t.inputSchema;
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const samples: Record<string, Record<string, unknown>> = {
    forks: { repo: "alice/lib" },
    following: { repo: "alice/lib-fork" },
    follow_mode: { repo: "alice/lib-fork", mode: "take-updates" },
    family: {},
  };

  for (const [name, args] of Object.entries(samples)) {
    test(`${name}: every argument is in backticks in its doc`, () => {
      const doc = docs[name] ?? "";
      expect(doc).not.toBe("");
      for (const prop of Object.keys((schemas[name]!["properties"] as object) ?? {}))
        expect(new RegExp(`\`[^\`]*\\b${prop}\\b[^\`]*\``).test(doc)).toBe(true);
    });

    test(`${name}: every top-level key of a sample answer is in its doc`, async () => {
      const answer = await call(name, args);
      expect(answer["error"]).toBeUndefined();
      for (const key of Object.keys(answer)) expect(docs[name]).toContain(key);
    });
  }

  test("following names the not-a-fork refusal", async () => {
    const answer = await call("following", { repo: "alice/lib" });
    expect(answer["error"]).toBe("not_a_fork");
    expect(docs["following"]).toContain(String(answer["error"]));
  });

  test("follow_mode names the refusals it gives", async () => {
    const answer = await call("follow_mode", { repo: "alice/lib", mode: "tell-me" });
    expect(docs["follow_mode"]).toContain(String(answer["error"]));
  });
});
