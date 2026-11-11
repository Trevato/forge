/** `flow` with { kind: drift, repo, pull, action: update } (#10909): what POST …/update does, as a writer, with its refusals. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setIssueState } from "../src/core/issues.ts";
import { activeRunFor } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let aliceTok: string;
let bobTok: string;
let roTok: string;
let id = 1;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-drift-update-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: username === "alice" });
    if (!u.ok) throw new Error(String(u.error));
    return u.value;
  };
  alice = await mk("alice");
  const bob = await mk("bob");
  aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
  roTok = createToken(app.db, alice.id, "ro", "ro").token;
  bobTok = createToken(app.db, bob.id, "rw", "rw").token;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "base", files: [{ path: "a.txt", content: "a\n" }] });
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function pullWith(agent: boolean) {
  const branch = `b${++n}`;
  const c = await commitToBranch(app, alice, repo, { branch, message: branch, files: [{ path: `${branch}.txt`, content: "x\n" }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  if (agent) {
    const a = await createAgent(app, alice, { username: `bot${n}` });
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(a.value.user.id, opened.value.id);
  }
  return opened.value;
}

const call = async (token: string, args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "flow", arguments: args } }),
  });
  const body: any = await res.json();
  const text: string = body.result?.content?.[0]?.text ?? JSON.stringify(body);
  return body.result?.isError === true || body.error ? { error: text } : { value: JSON.parse(text) };
};
const act = (tok: string, pull: number) => call(tok, { kind: "drift", repo: "alice/notes", pull, action: "update" });

test("a writer's update names the agent and queues its run", async () => {
  const p = await pullWith(true);
  const r = await act(aliceTok, p.number);
  expect(r.value.updating).toBe(`alice/notes!${p.number}`);
  expect(r.value.by).toStartWith("bot");
  expect(activeRunFor(app.db, "agent", p.id)).toBeDefined();
});

test("a closed pull is refused in the route's words, nothing queued", async () => {
  const p = await pullWith(true);
  setIssueState(app.db, p.id, "closed");
  const r = await act(aliceTok, p.number);
  expect(r.error).toContain("could not take it");
  expect(activeRunFor(app.db, "agent", p.id)).toBeUndefined();
});

test("a pull with no agent is refused", async () => {
  const p = await pullWith(false);
  expect((await act(aliceTok, p.number)).error).toContain("could not take it");
});

test("a pull whose tries are used is refused", async () => {
  const p = await pullWith(true);
  for (let i = 0; i < 20; i++) {
    app.db.run(
      "INSERT INTO run (id, kind, issue_id, repo_id, state, reason, created_at) VALUES (?1, 'agent', ?2, ?4, 'failed', 'check_failed', ?3)",
      [`r${n}-${i}`, p.id, new Date(Date.now() + 60_000).toISOString(), repo.id],
    );
  }
  const r = await act(aliceTok, p.number);
  expect(r.error).toContain("could not take it");
});

test("someone who cannot write, a read-only token, or a missing pull is refused", async () => {
  const p = await pullWith(true);
  expect((await act(bobTok, p.number)).error).toContain("Only someone who can write");
  expect((await act(roTok, p.number)).error).toBeDefined();
  expect((await act(aliceTok, 9999)).error).toContain("no pull");
  expect(activeRunFor(app.db, "agent", p.id)).toBeUndefined();
});
