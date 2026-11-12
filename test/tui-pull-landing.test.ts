/** The terminal's pull screen says when an approved pull will land, as the page does (#10860). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { submitReview } from "../src/core/reviews.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let forge: Forge;
let alice: User;
let repo: Repo;
let pull: Pull;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-landing-"));
  forge = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  await createAgent(forge, alice, { username: "bot" });
  const r = await createRepo(forge, alice, { name: "site", visibility: "public" });
  if (!r.ok) throw new Error("repo creation failed");
  repo = r.value;
  await commitToBranch(forge, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# s\n" }] });
  addToCrew(forge, alice, repo, "bot");
  await commitToBranch(forge, alice, repo, {
    branch: "bot/1",
    base: "main",
    message: "Tidy",
    files: [{ path: "F.md", content: "1\n" }],
  });
  const opened = await openPull(forge, getUserByName(forge.db, "bot")!, repo, {
    title: "Tidy",
    body: "",
    baseBranch: "main",
    headBranch: "bot/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
}, 30_000);

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function screenText(): Promise<string> {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(200, 44), exitHooks: false },
  );
  app.start();
  app.ctx.push(pullScreen(session, app.ctx, local(session, repo), pull.number));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

test("the pull screen says its place in the queue once approved, and not before", async () => {
  expect(await screenText()).not.toContain("in the queue");
  const end = new Date(Date.now() - 10 * 60_000);
  forge.db
    .query("INSERT INTO check_gate (id, repo_id, started_at, finished_at) VALUES ('g1', ?1, ?2, ?3)")
    .run(repo.id, new Date(end.getTime() - 14 * 60_000).toISOString(), end.toISOString());
  const r = submitReview(forge.db, {
    issueId: pull.id,
    authorId: alice.id,
    state: "approved",
    commitOid: pull.headOid,
  } as Parameters<typeof submitReview>[1]);
  expect(r.ok).toBe(true);
  expect(await screenText()).toContain("first in the queue: lands in about 15 min");
});
