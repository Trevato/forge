/**
 * The `prompts` tool is the `…/prompts` API over MCP: the same actions, so
 * the same rules. The token goes in once and no answer carries it back; the
 * source is faked, so nothing here reaches the network.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg, createTeam, addTeamMember } from "../src/core/orgs.ts";
import { canAdmin, canWrite } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import type { InstagramClient } from "../src/crew/instagram.ts";
import { startPromptRoutine, type PromptRoutineHandle } from "../src/crew/prompts.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

const TOKEN = "IGAAQzx7k9p2m4-secret-token-for-the-mcp-test-QQ";

const fake: InstagramClient = {
  me: async () => ({ id: "1", username: "gamehandle" }),
  latestReel: async () => undefined,
  comments: async () => [],
  refresh: async () => ({ token: "IGAAQfresh-QQ" }),
};

describe("MCP prompts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let routine: PromptRoutineHandle;
  let admin = "";
  let rw = "";
  let bob = "";
  let stranger = "";
  let id = 1;

  const rpc = async (token: string, method: string, params: unknown) => {
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
  const tool = async (token: string, args: unknown) => {
    const body = await rpc(token, "tools/call", { name: "prompts", arguments: args });
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true, value: body.result.isError ? undefined : JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-prompts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    routine = startPromptRoutine(app, { client: fake, everyMs: 3_600_000 });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!a.ok || !b.ok) throw new Error("users");
    promote(app.db, b.value);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    const c = await createUser(app.db, { origin: "seed", trusted: true,
      username: "carol", email: "carol@forge.local", password: "a-good-passphrase" });
    if (!c.ok) throw new Error("users");
    promote(app.db, c.value);
    stranger = createToken(app.db, c.value.id, "admin", "admin").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    // Bob writes to studio/game through a write team, and administers nothing.
    const org = createOrg(app.db, "studio", a.value.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "devs", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, b.value.id);
    const studio = await createRepo(app, org.value, { name: "game", visibility: "public" });
    if (!studio.ok) throw new Error(String(studio.error));
    expect(canWrite(app.db, studio.value, b.value)).toBe(true);
    expect(canAdmin(app.db, studio.value, b.value)).toBe(false);
  }, 30_000);

  afterAll(async () => {
    await routine.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin adds, lists, runs and removes a source, and no answer holds the token", async () => {
    const seen: string[] = [];
    const added = await tool(admin, { repo: "alice/game", action: "add", kind: "instagram", token: TOKEN, at: "15:00" });
    seen.push(added.text);
    expect(added.error).toBe(false);
    const sourceId = added.value.id as string;
    expect(added.value.kind).toBe("instagram");
    const listed = await tool(admin, { repo: "alice/game", action: "list" });
    seen.push(listed.text);
    expect(listed.value.items.map((s: any) => s.id)).toEqual([sourceId]);
    const ran = await tool(admin, { repo: "alice/game", action: "run", id: sourceId });
    seen.push(ran.text);
    expect(ran.error).toBe(false);
    expect(ran.value.account).toBe("gamehandle");
    const again = await tool(admin, { repo: "alice/game", action: "add", kind: "instagram", token: TOKEN, at: "15:00" });
    seen.push(again.text);
    expect(again.error).toBe(true);
    const removed = await tool(admin, { repo: "alice/game", action: "remove", id: sourceId });
    seen.push(removed.text);
    expect(removed.error).toBe(false);
    expect((await tool(admin, { repo: "alice/game", action: "list" })).value.items).toEqual([]);
    for (const text of seen) expect(text).not.toContain(TOKEN);
  });

  test("an unknown kind is refused with the API's error, and the token is not echoed", async () => {
    const r = await tool(admin, { repo: "alice/game", action: "add", kind: "tiktok", token: TOKEN, at: "15:00" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("invalid_kind");
    expect(r.text).not.toContain(TOKEN);
    expect((await tool(admin, { repo: "alice/game", action: "nope" })).error).toBe(true);
  });

  test("a writer who is not admin is refused every action, and a stranger too", async () => {
    const sourceId = (await tool(admin, { repo: "studio/game", action: "add", kind: "instagram", token: TOKEN, at: "15:00" })).value.id;
    const attempts = [
      { action: "add", kind: "instagram", token: TOKEN, at: "15:00" },
      { action: "list" },
      { action: "run", id: sourceId },
      { action: "remove", id: sourceId },
    ];
    for (const who of [bob, stranger])
      for (const a of attempts) {
        const r = await tool(who, { repo: "studio/game", ...a });
        expect(r.error).toBe(true);
        expect(r.text).toStartWith("not_found");
        expect(r.text).not.toContain(TOKEN);
      }
    // Nothing was touched: the admin still sees the source.
    expect((await tool(admin, { repo: "studio/game", action: "list" })).value.items).toHaveLength(1);
  });

  test("only an admin-scope token sees the tool or may call it", async () => {
    const names = async (t: string) => (await listVia((p) => rpc(t, "tools/list", p))).result.tools.map((x: any) => x.name);
    expect(await names(admin)).toContain("prompts");
    expect(await names(rw)).not.toContain("prompts");
    const direct = await rpc(rw, "tools/call", { name: "prompts", arguments: { repo: "alice/game", action: "list" } });
    expect(direct.error.code).toBe(-32602);
  });
});
