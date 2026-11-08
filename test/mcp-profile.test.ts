/** The `profile` tool is GET and PATCH /api/v1/user over MCP: the same shape, rules and errors. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP profile", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let ro: string;
  let rw: string;
  let id = 1;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "profile", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text), text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-profile-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    ro = createToken(app.db, a.value.id, "ro", "ro").token;
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person reads their profile as the API shows it, and updates it", async () => {
    const api: any = await (await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${admin}` } })).json();
    const read = await tool(admin, {});
    expect(read.value).toEqual(api);
    expect(read.text).not.toContain("alice@forge.local");
    const set = await tool(admin, { displayName: "Alice Liddell", commitEmail: "account" });
    expect(set.value.displayName).toBe("Alice Liddell");
    expect(set.value.commitEmail).toBe("account");
    expect(set.text).not.toContain("alice@forge.local");
    expect((await tool(admin, {})).value.displayName).toBe("Alice Liddell");
  });

  test("a bad field is refused with the API's error", async () => {
    expect((await tool(admin, { email: "x".repeat(400) + "@forge.local" })).error).toContain("invalid_email");
    expect((await tool(admin, { commitEmail: "everyone" })).error).toContain("invalid_commit_email");
    expect((await tool(admin, {})).value.displayName).toBe("Alice Liddell");
  });

  test("a read-only token reads its profile as the API shows it", async () => {
    const api: any = await (await fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${ro}` } })).json();
    expect((await tool(ro, {})).value).toEqual(api);
  });

  test("an update needs an admin-scope token: read-only and rw are refused, nothing changes", async () => {
    const before = (await tool(admin, {})).value.displayName;
    expect((await tool(ro, { displayName: "Mallory" })).error).toContain("forbidden");
    const res = await tool(rw, { displayName: "Mallory" });
    expect(res.error).toContain("forbidden");
    expect(res.error).toContain("admin-scope");
    expect((await tool(admin, {})).value.displayName).toBe(before);
  });
});
