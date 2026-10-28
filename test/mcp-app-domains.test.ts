/**
 * The `app_domains` tool is the API's domain routes over MCP: the same
 * actions, so the same host rules and the same refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainAddedText, domainRefusalText } from "../src/actions/domain_words.ts";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP app_domains", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let admin: string;
  let rw: string;
  let bob: string;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "app_domains", arguments: args },
      }),
    });
    const body: any = await res.json();
    if (body.error !== undefined) return { error: String(body.error.message) };
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-domains-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    runtime = new AppsRuntime(app, {
      domain: "apps.test",
      scheme: "http",
      publicPort: servers.port,
      forgeUrl: servers.url,
      concurrency: 1,
      dns: {
        resolveTxt: () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" })),
        resolveCname: () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" })),
      },
    });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    const made = await newApp(app, a.value, {
      name: "notes",
      description: "A place for notes",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
  });

  afterAll(async () => {
    await runtime.stop();
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  const repo = "alice/notes";

  test("an admin adds, checks, lists and removes a domain", async () => {
    const added = await tool(admin, { repo, action: "add", host: "App.Example.com" });
    expect(added.value.host).toBe("app.example.com");
    expect(added.value.verified).toBe(false);
    expect(added.value.records.length).toBe(2);
    expect(added.value.says).toBe(domainAddedText(added.value));

    const checked = await tool(admin, { repo, action: "check", host: "app.example.com" });
    expect(checked.value.verified).toBe(false);
    expect(checked.value.said).toContain("No TXT record");
    expect(checked.value.says).toBe(checked.value.said);

    const listed = await tool(admin, { repo, action: "list" });
    expect(listed.value.items.map((d: any) => d.host)).toEqual(["app.example.com"]);

    expect((await tool(admin, { repo, action: "remove", host: "app.example.com" })).value).toEqual({
      says: "app.example.com is removed. The forge no longer answers there.",
    });
    expect((await tool(admin, { repo, action: "list" })).value.items).toEqual([]);
    expect((await tool(admin, { repo, action: "check", host: "app.example.com" })).error).toContain("no_such_domain");
  });

  test("a non-admin is refused", async () => {
    expect((await tool(bob, { repo, action: "list" })).error).toContain("not_found");
    expect((await tool(bob, { repo, action: "add", host: "bob.example.com" })).error).toContain("not_found");
    expect((await tool(rw, { repo, action: "add", host: "rw.example.com" })).error).toBeDefined();
    expect((await tool(admin, { repo, action: "list" })).value.items).toEqual([]);
  });

  test("an invalid host, a reserved one and a bad action are refused", async () => {
    expect((await tool(admin, { repo, action: "add", host: "not a host" })).error).toContain("invalid_host");
    expect((await tool(admin, { repo, action: "add", host: "forge.test" })).error).toContain("reserved_host");
    expect((await tool(admin, { repo, action: "add" })).error).toContain("host");
    expect((await tool(admin, { repo, action: "drop", host: "a.example.com" })).error).toContain("action");
  });

  test("a refusal says what the settings page says for the same code", async () => {
    for (const [host, code] of [["not a host", "invalid_host"], ["forge.test", "reserved_host"]] as const) {
      const said = domainRefusalText(code, "That domain could not be added.");
      const got = await tool(admin, { repo, action: "add", host });
      expect(got.error).toContain(code);
      expect(got.error).toContain(said);
    }
    await tool(admin, { repo, action: "add", host: "dup.example.com" });
    const again = await tool(admin, { repo, action: "add", host: "dup.example.com" });
    expect(again.error).toContain(domainRefusalText("taken", ""));
    await tool(admin, { repo, action: "remove", host: "dup.example.com" });
  });
});
