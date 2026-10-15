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

const screenText = async (
  who: User | null = alice,
  of: Repo = repo,
): Promise<string> => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, of));
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
  createRun(forge.db, {
    repoId: repo.id,
    kind: "deploy",
    env: "pull-9",
    commitOid: "b".repeat(40),
    summary: "PREVIEW-MARKER",
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
  expect(text).not.toContain("PREVIEW-MARKER");
});

test("a non-reader sees nothing of a private repo's deploys", async () => {
  const b = await signUp(forge, {
    username: "bob",
    email: "bob@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error("signup failed");
  const r = await createRepo(forge, alice, { name: "vault", visibility: "private" });
  if (!r.ok) throw new Error("repo failed");
  const secret = createRun(forge.db, {
    repoId: r.value.id,
    kind: "deploy",
    env: "production",
    commitOid: "e".repeat(40),
    summary: "SECRET-MARKER",
  });
  forge.db
    .query("INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1,?2,?3,?4)")
    .run(secret.id, "i7", 77, "f".repeat(40));
  for (const who of [b.value]) {
    const text = await screenText(who, r.value);
    expect(text).toContain("No deploys");
    expect(text).not.toContain("SECRET-MARKER");
    expect(text).not.toContain("#77");
    expect(text).not.toContain("deploy production");
  }
  expect(await screenText(alice, r.value)).toContain("#77");
});
