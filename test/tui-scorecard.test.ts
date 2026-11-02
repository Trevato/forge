/** The crew scorecard in the terminal (#2677): a forge admin's only, the figures Settings → Crew shows. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun, finishRun, noteRunProgress } from "../src/core/runs.ts";
import { crewScorecards, crewScorecardSplits, recentWindow, spanText } from "../src/core/scorecard.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const TITLE = "Crew scorecard per agent";
/** The palette entry's hint: on screen only when the command is listed (the query echoes the title). */
const HINT = "each agent's pulls landed";
const DAY = 86_400_000;
let dirs: string[] = [];
let apps: App[] = [];

async function forge(): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), "forge-tui-scorecard-"));
  const app = createApp({ dataDir: dir, port: 0 });
  dirs.push(dir);
  apps.push(app);
  for (const [username, adminIfFirst] of [["ada", true], ["bob", false]] as const) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  return app;
}

async function agent(app: App, username: string): Promise<string> {
  const made = await createAgent(app, getUserByName(app.db, "ada"), { username });
  if (!made.ok) throw new Error(String(made.error));
  return made.value.user.id;
}
afterAll(async () => {
  for (const a of apps) a.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

function terminal(app: App, username: string) {
  const user = getUserByName(app.db, username)!;
  const { app: tui } = createForgeApp(
    app,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(200, 40), exitHooks: false },
  );
  tui.start();
  const key = (k: string, ctrl = false) =>
    tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  const t = {
    text: () => tui.screen.toText(),
    search: async () => {
      key(":");
      for (const ch of TITLE) key(ch);
      await settleApp(tui);
    },
    open: async () => {
      await t.search();
      key("enter");
      await settleApp(tui);
    },
    stop: () => tui.stop(),
  };
  return t;
}

let app: App;
let repoId = "";
const agentIds: Record<string, string> = {};

function pull(authorId: string, title: string, model: string, ageDays: number, merged: boolean): void {
  const issue = createIssue(app.db, { repoId, authorId, title, kind: "pull" });
  if (!issue.ok) throw new Error(issue.error);
  const opened = new Date(Date.now() - ageDays * DAY).toISOString();
  app.db.query("UPDATE issue SET created_at = ?2 WHERE id = ?1").run(issue.value.id, opened);
  app.db
    .query(
      `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
       VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
    )
    .run(
      issue.value.id,
      `h${issue.value.number}`,
      merged ? new Date(Date.parse(opened) + 3 * 3_600_000).toISOString() : null,
    );
  const run = createRun(app.db, { repoId, kind: "agent", actorId: authorId, issueId: issue.value.id });
  claimRun(app.db, run.id);
  noteRunProgress(app.db, run.id, { model, promptVersion: "v1" });
  finishRun(app.db, run.id, { state: "ok", summary: "" });
  const check = createRun(app.db, { repoId, kind: "check", issueId: issue.value.id });
  claimRun(app.db, check.id);
  finishRun(app.db, check.id, { state: merged ? "ok" : "failed", summary: "" });
}

beforeAll(async () => {
  app = await forge();
  const repo = await createRepo(app, getUserByName(app.db, "ada"), { name: "hello", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  repoId = repo.value.id;
  const smith = await agent(app, "smith");
  const jones = await agent(app, "jones");
  agentIds.smith = smith;
  agentIds.jones = jones;
  pull(smith, "s1", "opus", 40, true);
  pull(smith, "s2", "opus", 2, true);
  pull(smith, "s3", "haiku", 1, false);
  pull(jones, "j1", "opus", 3, true);
  pull(jones, "j2", "opus", 60, false);
});

test("an admin's terminal shows the figures crewScorecards gives, recent and all time, with a row per model", async () => {
  const all = crewScorecards(app.db);
  const recent = crewScorecards(app.db, recentWindow());
  const splits = crewScorecardSplits(app.db);
  expect(all.size).toBe(2);
  const t = terminal(app, "ada");
  await t.open();
  const text = t.text();
  for (const name of ["smith", "jones"]) {
    const id = agentIds[name]!;
    const a = all.get(id)!;
    const r = recent.get(id)!;
    expect(text).toContain(`landed 30d ${r.landed} of ${r.opened} · all ${a.landed} of ${a.opened}`);
    expect(text).toContain(`reverts ${a.reverts}`);
    expect(text).toContain(`time to land ${spanText(a.meanLandMs!)}`);
    expect(text).toContain(`red checks 30d ${Math.round(100 * r.redCheckRate!)}% · all ${Math.round(100 * a.redCheckRate!)}%`);
    expect(text).toContain(`all ${a.reviewRounds!.toFixed(1)}`);
    for (const p of splits.get(id)!) expect(text).toContain(`↳ ${p.model} · ${p.promptVersion}`);
  }
  expect(splits.get(agentIds.smith!)!.map((p) => p.model).sort()).toEqual(["haiku", "opus"]);
  t.stop();
});

test("the palette lists the scorecard for a forge admin and not for anyone else", async () => {
  const ada = terminal(app, "ada");
  await ada.search();
  expect(ada.text()).toContain(HINT);
  ada.stop();
  const bob = terminal(app, "bob");
  await bob.search();
  expect(bob.text()).not.toContain(HINT);
  await bob.open();
  expect(bob.text()).not.toContain("smith");
  expect(bob.text()).not.toContain("landed 30d");
  bob.stop();
});

test("with no crew at all it says so in one line, with no table", async () => {
  const empty = await forge();
  const t = terminal(empty, "ada");
  await t.open();
  const text = t.text();
  expect(text).toContain("No agents yet.");
  expect(text).not.toContain("landed 30d");
  expect(text).not.toContain("no pull yet");
  t.stop();
});
