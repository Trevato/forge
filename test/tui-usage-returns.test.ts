/**
 * The terminal's usage screen says what the crew's tokens bought (#7271), as
 * MCP `returns` reads it: dollars, runs, changes landed and cost per change
 * over 7 days, `[`/`]` to 1, 30 and 90; a repository's usage narrows to that
 * app; someone `returns` refuses sees no block; no runs is "nothing spent".
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
const DAY = 86_400_000;

function boot(username: string) {
  const user = getUserByName(forge.db, username)!;
  const { app } = createForgeApp(
    forge,
    { sshUsername: "t", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(160, 32), exitHooks: false },
  );
  app.start();
  const key = (k: string, ctrl = false) => app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
  const type = async (word: string) => {
    for (const ch of word) key(ch);
    await settleApp(app);
  };
  const enter = async () => {
    key("enter");
    await settleApp(app);
  };
  return {
    text: () => app.screen.toText(),
    key: async (k: string) => {
      key(k);
      await settleApp(app);
    },
    /** A palette command, and the `owner/name` its prompt asks for when it asks. */
    open: async (command: string, spec?: string) => {
      key("k", true);
      await type(command);
      await enter();
      if (spec !== undefined) {
        await type(spec);
        await enter();
      }
    },
    stop: () => app.stop(),
  };
}

/** One agent run on a new issue, ended `ago` days back; with `merged`, its pull merged then too. */
async function spend(repo: Repo, usd: number, ago: number, merged?: string): Promise<void> {
  const alice = getUserByName(forge.db, "alice")!;
  const bot = getUserByName(forge.db, "bot")!;
  const issue = openIssue(forge, alice, repo, { title: `work ${usd}` });
  if (!issue.ok) throw new Error(String(issue.error));
  const at = new Date(Date.now() - ago * DAY - 60_000).toISOString();
  const made = createRun(forge.db, {
    repoId: repo.id, kind: "agent", issueId: issue.value.id, branch: merged ?? "", actorId: bot.id, reason: "assigned",
  });
  forge.db
    .query("UPDATE run SET state = 'ok', cost_usd = ?2, summary = 'ok', created_at = ?3, started_at = ?3, finished_at = ?3 WHERE id = ?1")
    .run(made.id, usd, at);
  if (merged === undefined) return;
  await commitToBranch(forge, alice, repo, {
    branch: merged, base: "main", message: merged, files: [{ path: `${merged.replace(/\W/g, "-")}.md`, content: "work\n" }],
  });
  const pull = await openPull(forge, bot, repo, {
    title: `Work on #${issue.value.number}`, body: `Closes #${issue.value.number}`, baseBranch: "main", headBranch: merged,
  });
  if (!pull.ok) throw new Error(String(pull.error));
  forge.db.query("UPDATE pull SET merged_at = ?2 WHERE issue_id = ?1").run(pull.value.id, at);
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-usage-returns-"));
  forge = createApp({ dataDir, port: 0 });
  for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed",
      trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
  }
  const alice = getUserByName(forge.db, "alice")!;
  await createAgent(forge, alice, { username: "bot" });
  const repos: Repo[] = [];
  for (const name of ["mill", "kiln", "empty"]) {
    const made = await createRepo(forge, alice, { name, visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(forge, alice, made.value, { message: "seed", files: [{ path: "README.md", content: `# ${name}\n` }] });
    addToCrew(forge, alice, made.value, "bot");
    repos.push(made.value);
  }
  const [mill, kiln] = repos;
  await spend(mill!, 1, 0, "bot/1-landed"); // this week: $1, landed
  await spend(mill!, 0.5, 1); // this week: $0.50, nothing merged
  await spend(mill!, 3, 20, "bot/3-old"); // this month: $3, landed
  await spend(kiln!, 5, 2); // this week, another app: $5, nothing merged
}, 30_000);
afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the owner's usage says what 7 days bought, and ] widens it to 30", async () => {
  const h = boot("alice");
  await h.open("Usage");
  expect(h.text()).toContain("Returns, 7 days: $6.50 over 3 runs · 1 change landed · $1.00 a landed change (median)");
  await h.key("]");
  expect(h.text()).toContain("Returns, 30 days: $9.50 over 4 runs · 2 changes landed · $3.00 a landed change (median)");
  await h.key("[");
  await h.key("[");
  expect(h.text()).toContain("Returns, 1 day: $1.00 over 1 run · 1 change landed · $1.00 a landed change (median)");
  h.stop();
});

test("a repository's usage narrows to that app, and no runs reads nothing spent", async () => {
  const h = boot("alice");
  await h.open("Usage of a repository", "alice/kiln");
  expect(h.text()).toContain("Returns, 7 days: $5.00 over 1 run · 0 changes landed · no landed change to cost");
  expect(h.text()).not.toContain("routes had no request");
  h.stop();
  const e = boot("alice");
  await e.open("Usage of a repository", "alice/empty");
  expect(e.text()).toContain("Returns, 7 days: nothing spent · 0 changes landed");
  expect(e.text()).not.toContain("NaN");
  e.stop();
});

test("a reader the returns tool refuses sees no returns block", async () => {
  const h = boot("bob");
  await h.open("Usage of a repository", "alice/mill");
  expect(h.text()).toContain("Usage · alice/mill");
  expect(h.text()).not.toContain("Returns,");
  expect(h.text()).not.toContain("$");
  const before = h.text();
  await h.key("]");
  await h.key("[");
  expect(h.text()).toBe(before);
  h.stop();
});

test("Forge spend is a palette entry: an admin reads every app, a writer of none reads none", async () => {
  const h = boot("alice");
  await h.open("Forge spend");
  expect(h.text()).toContain("Forge spend");
  expect(h.text()).toContain("3 apps · today $");
  expect(h.text()).toContain("last 24 h $");
  h.stop();
  const b = boot("bob");
  await b.open("Forge spend");
  expect(b.text()).toContain("0 apps · today $0.00 over 0 runs");
  b.stop();
});
