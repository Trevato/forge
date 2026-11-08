/**
 * The decider's per-app cost line: what one shipped change cost this week,
 * in the board's own words, only for someone holding owner facts.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { efficiencyForRepos, perShippedWords } from "../src/core/efficiency.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deciderScreen, efficiencyLines } from "../src/tui/screens/decider.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

/** A repository made by the admin and handed to `owner`, who is not a member. */
async function ownedBy(owner: User, name: string): Promise<Repo> {
  const made = await createRepo(app, alice, { name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  app.db.query("UPDATE repo SET owner_id = ?1 WHERE id = ?2").run(owner.id, made.value.id);
  return made.value;
}

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-decider-eff-"));
  app = createApp({ dataDir: dir, port: 0 });
  const mk = async (username: string, first = false) => {
    const r = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  alice = await mk("alice", true);
  bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const at = new Date().toISOString();
  for (let n = 0; n < 2; n++)
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: repo.id, kind: "agent", actorId: alice.id }).id, repoId: repo.id, issueId: null, agentId: null, subscriptionId: null,
      tokensIn: 1, tokensOut: 1, costUsd: 1.5, wallMs: 1, outcome: "ok", at,
    });
  const issue = openIssue(app, alice, repo, { title: "Shipped" });
  if (!issue.ok) throw new Error(String(issue.error));
  app.db
    .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, 'main', 'b', '', '', ?2, ?3)`)
    .run(issue.value.id, repo.id, at);
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

async function screenText(user: User): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(deciderScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

test("the owner's screen says what a shipped change cost, as the board does", async () => {
  const week = efficiencyForRepos(app.db, [repo.id], new Date(Date.now() - 7 * 86_400_000).toISOString());
  const words = perShippedWords(week.get(repo.id));
  expect(words).toBe("$3.00 per shipped change");
  expect(efficiencyLines(app, alice)).toEqual([`notes: ${words} this week`]);
  expect(await screenText(alice)).toContain(`notes: ${words} this week`);
});

test("a reader with no owner facts sees no line", async () => {
  expect(efficiencyLines(app, bob)).toEqual([]);
  expect(efficiencyLines(app, undefined)).toEqual([]);
  expect(await screenText(bob)).not.toContain("per shipped change");
});

test("an owner whose app neither ran nor shipped gets no line", async () => {
  const carol = await createUser(app.db, {
    origin: "seed", trusted: true, username: "carol", email: "carol@forge.local", password: "a-good-passphrase",
  });
  if (!carol.ok) throw new Error(carol.error);
  await ownedBy(carol.value, "idle");
  expect(efficiencyLines(app, carol.value)).toEqual([]);
});

test("many apps: three lines then +N more apps, and the pile rows stay on a short terminal", async () => {
  const dave = await createUser(app.db, {
    origin: "seed", trusted: true, username: "dave", email: "dave@forge.local", password: "a-good-passphrase",
  });
  if (!dave.ok) throw new Error(dave.error);
  const at = new Date().toISOString();
  for (let n = 0; n < 5; n++) {
    const made = { value: await ownedBy(dave.value, `app${n}`) };
    recordUsage(app.db, {
      runId: createRun(app.db, { repoId: made.value.id, kind: "agent", actorId: dave.value.id }).id, repoId: made.value.id, issueId: null, agentId: null, subscriptionId: null,
      tokensIn: 1, tokensOut: 1, costUsd: 1, wallMs: 1, outcome: "ok", at,
    });
  }
  const lines = efficiencyLines(app, dave.value);
  expect(lines).toHaveLength(4);
  expect(lines[3]).toBe("+2 more apps");

  const terminal = headlessTerminal(80, 12);
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: "dave", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: dave.value },
    { terminal, exitHooks: false },
  );
  tui.start();
  tui.ctx.push(deciderScreen(session, tui.ctx));
  await settleApp(tui);
  const text = tui.screen.toText();
  tui.stop?.();
  expect(text).toContain("+2 more apps");
  expect(text).toContain("The decider has done nothing today.");
  expect(text).toContain("Press 1, 2 or 3 for another pile.");
});
