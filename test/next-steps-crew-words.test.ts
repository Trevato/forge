/**
 * The first-login card names the crew at work in plain words (#11364):
 * "<name> is <doing what>", with no run ids, branch names or pull numbers.
 */
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue, assignIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { getRepoById } from "../src/core/repos.ts";
import type { Ctx } from "../src/http/context.ts";
import { appCrew } from "../src/core/app-crew.ts";
import { crewAtWork } from "../src/web/pages/next-steps.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-crew-words-"));
  app = createApp({ dataDir: dir, port: 0 });
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

/** An app whose running direction carries `title`; returns what the card and the terminal's source say. */
let n = 0;
async function appWith(title: string) {
  const maria = getUserByName(app.db, "maria")!;
  const atlas = getUserByName(app.db, "atlas")!;
  const created = await createRepo(app, maria, { name: `bakery${++n}`, visibility: "private" });
  if (!created.ok) throw new Error("repo");
  addToCrew(app, maria, created.value, "atlas");
  const issue = openIssue(app, maria, created.value, { title: `Direction: ${title}` });
  if (!issue.ok) throw new Error("issue");
  assignIssue(app, maria, created.value, issue.value, atlas);
  app.db.query("UPDATE repo SET direction_issue_id = ?1 WHERE id = ?2").run(issue.value.id, created.value.id);
  const run = createRun(app.db, { repoId: created.value.id, kind: "agent", issueId: issue.value.id, actorId: atlas.id, reason: "assigned" });
  claimRun(app.db, run.id);
  const repo = getRepoById(app.db, created.value.id)!;
  const rows = crewAtWork({ app } as unknown as Ctx, [repo]).map(String).join(" ");
  const text = rows
    .replace(/<[^>]*>/g, " ")
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return { repo, text, rows, runId: run.id, says: appCrew(app.db, [repo])[0]!.says };
}

beforeAll(async () => {
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "maria", email: "m@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error("user");
  const made = await createAgent(app, r.value, { username: "atlas" });
  if (!made.ok) throw new Error("agent");
});

test("a clause that introduces a pull number or branch goes with it: the whole sentence is plain", async () => {
  const a = await appWith("Run Maria's bakery, as in PR #42 on mason/12-menu-page");
  expect(a.says).toBe("atlas is working toward Run Maria's bakery");
  expect(a.text).toBe(`atlas is working toward Run Maria's bakery ${a.repo.name}`);
  expect(a.rows).not.toContain(a.runId);
  expect(a.text).not.toMatch(/#\d|\bPR\b|mason\/|\/issues\//);
});

test("a title that is only identifiers says the app's name, not a fragment", async () => {
  const a = await appWith("PR #42");
  expect(a.says).toBe(`atlas is working toward ${a.repo.name}`);
  const b = await appWith("see #7 on mason/12-menu-page");
  expect(b.says).toBe(`atlas is working toward ${b.repo.name}`);
});

test("ordinary words that look a little like identifiers survive", async () => {
  expect((await appWith("Run 5 miles of menu pages")).says).toBe("atlas is working toward Run 5 miles of menu pages");
  expect((await appWith("Open the shop and/24-hour support page")).says).toBe("atlas is working toward Open the shop and/24-hour support page");
});
