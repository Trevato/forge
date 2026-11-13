/**
 * Every MCP tool that writes, called with a read-only token, is refused
 * before it writes; every tool that needs an admin token is refused to an
 * `rw` one. The event log, every table's row count and every counter row
 * outside `/mcp` stay as they were (see test/helpers/write-snapshot.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { toolRegistry, toolNames } from "../src/http/mcp.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { ownCount, snapshot } from "./helpers/write-snapshot.ts";

/** Tools this test cannot call as a write, by name, and why. */
const SKIPPED: Record<string, string> = {};

/** Valid arguments for each admin-scope tool: were its gate gone, the call would act. */
const ADMIN_ARGS: Record<string, Record<string, unknown>> = {
  repo_settings: { repo: "alice/game", visibility: "public" },
  sessions: { action: "end", id: "x" },
  mirror_set: { action: "forget" },
  mirror_now: {},
  org_teams: { org: "acme", action: "create", team: "core", permission: "read" },
  agent: { action: "create", username: "robo", displayName: "Robo", model: "m", brief: "b" },
  subscription_budget: { id: "u1", usd: 5 },
  subscription_delete: { id: "u1" },
  subscription_add: { name: "Sneaky", token: "sk-ant-oat01-aaaaaaaaaaaaaaaaaaaa" },
  subscription_wake: { id: "u1" },
  subscription_headroom: { id: "u1", percent: 30 },
  prompts: { repo: "alice/game", action: "remove", id: "p1" },
  release_hold: { reason: "freeze for the demo" },
  release_now: { reason: "hotfix for the demo" },
  telemetry_grant: { agent: "robo", on: true },
  hooks: { repo: "alice/game", action: "add", url: "https://example.com/h", secret: "0123456789abcdef0123" },
  app_domains: { repo: "alice/game", action: "add", host: "game.example.com" },
  backups_destination: { action: "set", bucket: "forge-snaps", accessKey: "AKIA", secretKey: "s3cr3t-key-0123456789" },
  backups_test: { endpoint: "http://127.0.0.1:1", bucket: "b", accessKey: "AKIA", secretKey: "s3cr3t-key-0123456789" },
  rollback: { sha: "a".repeat(40), dryRun: false },
};

/** Valid arguments for a tool whose write is one call among reads and plans (`readsWhen`): the generic arguments would only read. */
const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  flow: { kind: "drift", action: "update", repo: "alice/game", pull: 1 },
};

/** What `visible()` answers for a tool the token's scope does not open. */
const notListed = (body: any): boolean =>
  body.error?.code === -32602 && String(body.error.message).startsWith("no tool named");

describe("a token that may only read cannot write through any tool", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ro = "";
  let rw = "";
  let id = 1;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-scope-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app, made.value, { name: "game", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    ro = createToken(app.db, made.value.id, "ro", "ro").token;
    rw = createToken(app.db, made.value.id, "rw", "rw").token;
  }, 30_000);
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rpc = async (token: string, name: string, args: Record<string, unknown>) => {
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
        params: { name, arguments: args },
      }),
    });
    return (await res.json()) as any;
  };

  /** Minimal arguments that make the call a real write, not a plan or a list. */
  const writing = (t: ReturnType<typeof toolRegistry>[number]) => {
    if (t.name in ADMIN_ARGS) return ADMIN_ARGS[t.name]!;
    if (t.name in WRITE_ARGS) return WRITE_ARGS[t.name]!;
    const args: Record<string, unknown> = { dryRun: false, action: "x" };
    if (t.readsWithout !== undefined) args[[t.readsWithout].flat()[0]!] = "x";
    return args;
  };

  test("the list of skipped tools names only tools that exist", () => {
    const names = new Set(toolNames());
    for (const name of Object.keys(SKIPPED)) expect(names.has(name)).toBe(true);
  });

  test("each write is refused for a read-only token, and nothing changes", async () => {
    const writes = toolRegistry().filter((t) => t.writes && !(t.name in SKIPPED));
    expect(writes.length).toBeGreaterThan(50);
    const before = snapshot(app.db);
    const counted = ownCount(app.db);
    const events = app.db.query("SELECT * FROM event ORDER BY rowid").all();
    const unrefused: string[] = [];
    const planned: string[] = [];
    for (const t of writes) {
      const args = writing(t);
      if (t.plansOnly(args)) {
        planned.push(t.name);
        continue;
      }
      const body = await rpc(ro, t.name, args);
      const text: string | undefined = body.result?.content?.[0]?.text;
      const refused = t.needsAdminScope
        ? notListed(body)
        : body.result?.isError === true && text === "forbidden: this token may read, not act";
      if (!refused) unrefused.push(t.name);
    }
    // A tool named here needs valid arguments in WRITE_ARGS: the generic ones only plan or read.
    expect(planned).toEqual([]);
    expect(unrefused).toEqual([]);
    expect(snapshot(app.db)).toEqual(before);
    expect(ownCount(app.db)).toBeGreaterThanOrEqual(counted);
    expect(app.db.query("SELECT * FROM event ORDER BY rowid").all()).toEqual(events);
  }, 60_000);

  test("each admin-scope tool is refused for an rw token, and nothing changes", async () => {
    const admin = toolRegistry().filter((t) => t.needsAdminScope);
    expect(admin.length).toBeGreaterThan(0);
    // A new admin-scope tool must be given valid arguments here.
    expect(admin.map((t) => t.name).sort()).toEqual(Object.keys(ADMIN_ARGS).sort());
    const before = snapshot(app.db);
    const counted = ownCount(app.db);
    const events = app.db.query("SELECT * FROM event ORDER BY rowid").all();
    const answered: string[] = [];
    for (const t of admin) {
      const body = await rpc(rw, t.name, writing(t));
      if (!notListed(body)) answered.push(t.name);
    }
    expect(answered).toEqual([]);
    expect(snapshot(app.db)).toEqual(before);
    expect(ownCount(app.db)).toBeGreaterThanOrEqual(counted);
    expect(app.db.query("SELECT * FROM event ORDER BY rowid").all()).toEqual(events);
  }, 60_000);
});
