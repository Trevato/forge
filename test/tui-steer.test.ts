/** The terminal says a word to a running crew run, as the run page and MCP `steer` do (#7288). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { steerRefusedWords } from "../src/actions/steer_words.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo as makeRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listComments, type Issue } from "../src/core/issues.ts";
import { addTeamMember, createOrg, createTeam, removeTeamMember } from "../src/core/orgs.ts";
import { canWrite, createRepo, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listenForSteer } from "../src/crew/runner.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issueScreen } from "../src/tui/screens/issue.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { local } from "../src/tui/screens/where.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bot: User;
let orgId: string;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-steer-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const agent = await createAgent(forge, alice, { username: "robo" });
  if (!agent.ok) throw new Error("agent failed");
  bot = agent.value.user;
  // An org's repositories, so a team can make the agent a writer.
  const org = createOrg(forge.db, "acme", alice.id);
  if (!org.ok) throw new Error("org failed");
  orgId = org.value.id;
  const writers = createTeam(forge.db, orgId, "Writers", "write");
  if (!writers.ok) throw new Error("team failed");
  addTeamMember(forge.db, writers.value, bot.id);
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** A repository with one issue and one agent run on it, claimed unless `finished`. */
async function seed(finished = false): Promise<{ repo: Repo; issue: Issue; runId: string }> {
  const r = await createRepo(forge.db, forge.reposRoot, { ownerId: orgId, name: `lamp${n++}`, visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  if (!addToCrew(forge, alice, r.value, "robo").ok) throw new Error("crew failed");
  const issue = openIssue(forge, alice, r.value, { title: "Say hello" });
  if (!issue.ok) throw new Error("issue failed");
  const run = createRun(forge.db, {
    repoId: r.value.id,
    kind: "agent",
    issueId: issue.value.id,
    actorId: bot.id,
  });
  claimRun(forge.db, run.id);
  if (finished) finishRun(forge.db, run.id, { state: "ok", summary: "done" });
  return { repo: r.value, issue: issue.value, runId: run.id };
}

async function open(user: User, push: (session: any, ctx: any) => any) {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(push(session, app.ctx));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  const type = async (text: string): Promise<void> => {
    for (const ch of text) await press(ch);
  };
  return { app, press, type, text: () => app.screen.toText() };
}

test("S on the runs list sends the word to the running agent and says so", async () => {
  const { repo, runId } = await seed();
  const heard: string[] = [];
  const stop = listenForSteer(runId, (t) => {
    heard.push(t);
    return true;
  });
  const h = await open(alice, (s, ctx) => runsScreen(s, ctx, repo));
  expect(h.text()).toMatch(/S +steer/);
  expect(await h.press("S")).toContain("Steer the run");
  await h.type("also add a test");
  const text = await h.press("enter");
  expect(heard).toEqual(["also add a test"]);
  expect(text).toContain("Sent. The agent hears it at its next step.");
  stop();
  h.app.stop();
});

test("with no session listening the word goes on the conversation", async () => {
  const { repo, issue } = await seed();
  const h = await open(alice, (s, ctx) => runsScreen(s, ctx, repo));
  await h.press("S");
  await h.type("try the other door");
  const text = await h.press("enter");
  expect(text).toContain("Commented.");
  expect(listComments(forge.db, issue.id).map((c) => c.body)).toContain("try the other door");
  h.app.stop();
});

test("empty text is refused in place and nothing is said", async () => {
  const { repo, runId } = await seed();
  const heard: string[] = [];
  const stop = listenForSteer(runId, (t) => {
    heard.push(t);
    return true;
  });
  const h = await open(alice, (s, ctx) => runsScreen(s, ctx, repo));
  await h.press("S");
  await h.type("   ");
  const text = await h.press("enter");
  expect(text).toContain("Steer the run");
  expect(text).toContain("Say something first.");
  expect(heard).toEqual([]);
  stop();
  h.app.stop();
});

test("a finished run is not offered steering", async () => {
  const { repo, issue } = await seed(true);
  const h = await open(alice, (s, ctx) => runsScreen(s, ctx, repo));
  expect(h.text()).not.toMatch(/S +steer/);
  expect(await h.press("S")).not.toContain("Steer the run");
  expect(listComments(forge.db, issue.id)).toHaveLength(0);
  h.app.stop();
});

test("the issue's crew card steers with s", async () => {
  const { repo, issue, runId } = await seed();
  const heard: string[] = [];
  const stop = listenForSteer(runId, (t) => {
    heard.push(t);
    return true;
  });
  const h = await open(alice, (s, ctx) => issueScreen(s, ctx, local(s, repo), issue.number));
  await h.press("tab");
  expect(h.text()).toMatch(/s +steer/);
  expect(await h.press("s")).toContain("Steer the run");
  await h.type("smaller steps");
  expect(await h.press("enter")).toContain("Sent.");
  expect(heard).toEqual(["smaller steps"]);
  stop();
  h.app.stop();
});

test("the pull's Crew tab steers with s", async () => {
  const repo = await makeRepo(forge, alice, { name: `pull${n++}`, visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  for (const branch of ["main", "topic"]) {
    const done = await commitToBranch(forge, alice, repo.value, {
      branch,
      message: "edit",
      files: [{ path: `${branch}.txt`, content: "x\n" }],
    });
    if (!done.ok) throw new Error(JSON.stringify(done.error));
  }
  if (!addToCrew(forge, alice, repo.value, "robo").ok) throw new Error("crew failed");
  const pull = await openPull(forge, alice, repo.value, { title: "Topic", baseBranch: "main", headBranch: "topic" });
  if (!pull.ok) throw new Error(String(pull.error));
  const run = createRun(forge.db, { repoId: repo.value.id, kind: "agent", issueId: pull.value.id, actorId: bot.id });
  claimRun(forge.db, run.id);
  const heard: string[] = [];
  const stop = listenForSteer(run.id, (t) => {
    heard.push(t);
    return true;
  });
  const h = await open(alice, (s, ctx) => pullScreen(s, ctx, local(s, repo.value), pull.value.number));
  const end = Date.now() + 3_000;
  while (!h.text().includes("Crew")) {
    if (Date.now() > end) throw new Error(h.text());
    await settleApp(h.app);
    await Bun.sleep(20);
  }
  await h.press("tab");
  await h.press("tab");
  expect(h.text()).toMatch(/s +steer/);
  expect(await h.press("s")).toContain("Steer the run");
  await h.type("one file at a time");
  expect(await h.press("enter")).toContain("Sent.");
  expect(heard).toEqual(["one file at a time"]);
  stop();
  h.app.stop();
});

test("an agent session that may write is not offered steering", async () => {
  const { repo, runId } = await seed();
  expect(canWrite(forge.db, repo, bot)).toBe(true);
  const heard: string[] = [];
  const stop = listenForSteer(runId, (t) => {
    heard.push(t);
    return true;
  });
  const h = await open(bot, (s, ctx) => runsScreen(s, ctx, repo));
  expect(h.text()).not.toMatch(/S +steer/);
  expect(await h.press("S")).not.toContain("Steer the run");
  expect(heard).toEqual([]);
  stop();
  h.app.stop();
});

test("a refusal reads as the run page and MCP read it", async () => {
  const { repo, issue } = await seed();
  const c = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "carol",
    email: "carol@forge.test",
    password: "a-long-passphrase",
  });
  if (!c.ok) throw new Error("carol failed");
  const writers = createTeam(forge.db, orgId, "Carol's", "write");
  if (!writers.ok) throw new Error("team failed");
  addTeamMember(forge.db, writers.value, c.value.id);
  const h = await open(c.value, (s, ctx) => runsScreen(s, ctx, repo));
  await h.press("S");
  await h.type("hello");
  // Her write access goes after the prompt opened: the action refuses.
  removeTeamMember(forge.db, writers.value, c.value.id);
  const text = await h.press("enter");
  expect(text).toContain(steerRefusedWords("forbidden"));
  expect(listComments(forge.db, issue.id)).toHaveLength(0);
  h.app.stop();
});
