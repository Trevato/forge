/** The deploys screen: production deploys, each with the pulls it carries. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await signUp(forge, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const screenText = async (): Promise<string> => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, repo));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
};

test("with no deploys the screen says so", async () => {
  expect(await screenText()).toContain("No deploys");
});

test("a production deploy with no issue is listed, with what it carries", async () => {
  const run = createRun(forge.db, {
    repoId: repo.id,
    kind: "deploy",
    env: "production",
    commitOid: "a".repeat(40),
    reason: "push",
  });
  const other = createRun(forge.db, {
    repoId: repo.id,
    kind: "deploy",
    env: "pull-9",
    commitOid: "b".repeat(40),
    summary: "a preview",
  });
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(run.id, "i3", 3, "c".repeat(40));
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(run.id, "i5", 5, "d".repeat(40));
  const text = await screenText();
  expect(text).toContain("deploy production");
  expect(text).toContain("carries #3 #5");
  expect(text).not.toContain("a preview");
  expect(other.id).not.toBe(run.id);
});
