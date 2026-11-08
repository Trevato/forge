/** The day's digest says the same lines on the web home, the terminal dashboard and MCP `feed` (#5803). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { lastVisit } from "../src/core/home_visit.ts";
import { sinceDigest } from "../src/web/studio/since.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-digest-doors-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.test", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  promote(app.db, alice);
  const g = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!g.ok) throw new Error("repo");
  for (const v of ["1.2.3", "1.2.4"]) app.bus.append({ kind: "app.serving", repoId: g.value.id, payload: { app: "garden", env: "production", commitOid: "a".repeat(40), version: v } });
  app.db.query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES ('d1', ?1, 1, 'pull', 't', ?2)").run(g.value.id, alice.id);
  app.db.query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES ('d1', 'main', 'h', 'a', 'b', ?1)").run(new Date(Date.now() - 600_000).toISOString());
});

afterAll(async () => {
  servers.stop?.();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("web, terminal and MCP give identical digest lines for one seeded forge", async () => {
  const cookie = `forge_session=${createSession(app.db, alice.id).token}; forge_mode=studio`;
  const page = await fetch(`${servers.url}/feed`, { headers: { cookie } }).then((r) => r.text());
  const d = sinceDigest(app.db, alice, lastVisit(app.db, alice.id), Date.now())!;
  expect(d).toBeDefined();
  const lines = d.lines;
  expect(lines.length).toBeGreaterThan(0);

  expect(page).toContain('id="since-you-were-here"');
  for (const l of lines) {
    expect(page).toContain(l.href);
    expect(page).toContain(l.says);
  }

  const token = createToken(app.db, alice.id, "digest", "ro").token;
  const feed = async (args: object): Promise<any> => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "feed", arguments: args } }),
    });
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };
  const body = await feed({});
  expect(body.digest.lines).toEqual(lines);
  const first = await feed({ limit: 1 });
  expect(first.digest.lines).toEqual(lines);
  expect(first.next_cursor).toBeTruthy();
  expect("digest" in (await feed({ limit: 1, cursor: first.next_cursor }))).toBe(false);

  const terminal = headlessTerminal(200, 32);
  const { app: tui } = createForgeApp(app, { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice }, { terminal, exitHooks: false });
  tui.start();
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop();
  expect(text).toContain("Since you were here");
  for (const l of lines) expect(text).toContain(l.says);
});
