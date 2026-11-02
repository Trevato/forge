/** `releases` is the /releases page over MCP: the same list, the same gate, no rollback. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { recordRelease } from "../src/release/record.ts";

const LIVE = "a".repeat(40);
const OLD = "b".repeat(40);

describe("MCP releases", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let bob: string;
  let repoId: string;
  let n = 1;
  const saved = process.env["FORGE_COMMIT"];

  const call = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: n++,
        method: "tools/call",
        params: { name: "releases", arguments: {} },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    process.env["FORGE_COMMIT"] = LIVE;
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-releases-"));
    app = createApp({ dataDir, port: 0, forgeRepo: "alice/forge" });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "forge", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
  }, 30_000);

  afterAll(async () => {
    if (saved === undefined) delete process.env["FORGE_COMMIT"];
    else process.env["FORGE_COMMIT"] = saved;
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a forge with no kept releases answers an empty list", async () => {
    expect((await call(admin)).value).toEqual({ items: [] });
  });

  test("a reader the page allows sees them newest first, the live one marked", async () => {
    recordRelease(app.db, { sha: OLD, repoId, pullNumber: 1, ok: true, line: "ok" });
    recordRelease(app.db, { sha: LIVE, repoId, pullNumber: 2, ok: true, line: "ok" });
    const { items } = (await call(admin)).value;
    expect(items.map((i: any) => i.sha)).toEqual(["a".repeat(12), "b".repeat(12)]);
    expect(items[0].live).toBe(true);
    expect(typeof items[0].since).toBe("string");
    expect(items[0].pull).toEqual({ repo: "alice/forge", number: 2 });
    expect(items[1].live).toBeUndefined();
  });

  test("one the page refuses gets its refusal", async () => {
    const r = await call(bob);
    expect(r.error).toContain("release history");
  });
});
