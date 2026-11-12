/** POST /:owner/:name/pulls/:number/update: a writer asks the pull's agent to bring it up to date; nobody else, no closed pull, no cross-origin post. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { activeRunFor } from "../src/core/runs.ts";
import { setIssueState } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import type { Repo } from "../src/core/repos.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let aliceCookie: string;
let bobCookie: string;
let n = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-update-pull-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const mk = async (username: string) => {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: username === "alice",
    });
    if (!u.ok) throw new Error(String(u.error));
    return u.value;
  };
  alice = await mk("alice");
  const bob = await mk("bob");
  aliceCookie = `forge_session=${createSession(app.db, alice.id).token}`;
  bobCookie = `forge_session=${createSession(app.db, bob.id).token}`;
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "base", files: [{ path: "a.txt", content: "a\n" }] });
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** An open pull assigned to a fresh agent, so there is someone to ask. */
async function agentPull() {
  const branch = `b${++n}`;
  const c = await commitToBranch(app, alice, repo, { branch, message: branch, files: [{ path: `${branch}.txt`, content: "x\n" }] });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  const agent = await createAgent(app, alice, { username: `bot${n}` });
  if (!agent.ok) throw new Error(JSON.stringify(agent.error));
  app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(agent.value.user.id, opened.value.id);
  return opened.value;
}

const post = (number: number, cookie: string | undefined, origin = servers.url) =>
  fetch(`${servers.url}/alice/notes/pulls/${number}/update`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), origin, accept: "application/json" },
    body: new URLSearchParams({ back: "/boards" }),
    redirect: "manual",
  });

test("a writer asks the agent: it is named and a run is queued", async () => {
  const pull = await agentPull();
  const res = await post(pull.number, aliceCookie);
  expect(res.status).toBe(200);
  const body = JSON.stringify(await res.json());
  expect(body).toContain("is bringing");
  expect(body).toContain(`#${pull.number}`);
  expect(activeRunFor(app.db, "agent", pull.id)).toBeDefined();
});

test("someone who cannot write is refused and nothing is queued", async () => {
  const pull = await agentPull();
  const res = await post(pull.number, bobCookie);
  expect(res.status).toBe(422);
  expect(JSON.stringify(await res.json())).toContain("Only someone who can write");
  expect(activeRunFor(app.db, "agent", pull.id)).toBeUndefined();
});

test("a closed pull cannot be asked", async () => {
  const pull = await agentPull();
  setIssueState(app.db, pull.id, "closed");
  const res = await post(pull.number, aliceCookie);
  expect(res.status).toBe(422);
  expect(JSON.stringify(await res.json())).toContain("could not take it");
  expect(activeRunFor(app.db, "agent", pull.id)).toBeUndefined();
});

test("a cross-origin post is refused and nothing is queued", async () => {
  const pull = await agentPull();
  const res = await post(pull.number, aliceCookie, "https://evil.example");
  expect(res.status).toBe(403);
  expect(activeRunFor(app.db, "agent", pull.id)).toBeUndefined();
});
