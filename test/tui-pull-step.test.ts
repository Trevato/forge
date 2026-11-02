/** The terminal's feed, pulls list and on-you list say a pull's step too (#7783). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { stepLine, stepOfStored } from "../src/flow/path.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { feedScreen } from "../src/tui/screens/feed.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
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
let one: Pull;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-step-"));
  forge = createApp({ dataDir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "steps", visibility: "public" });
  if (!r.ok) throw new Error("repo creation failed");
  repo = r.value;
  await commitToBranch(forge, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# s\n" }] });
  await commitToBranch(forge, alice, repo, {
    branch: "feature/one",
    base: "main",
    message: "One",
    files: [{ path: "one.ts", content: "export const one = 1;\n" }],
  });
  const opened = await openPull(forge, alice, repo, {
    title: "Pull one",
    body: "",
    baseBranch: "main",
    headBranch: "feature/one",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  one = opened.value;
  forge.db.query("UPDATE issue SET assignee_id = ?2 WHERE id = ?1").run(one.id, alice.id);
});

afterAll(async () => {
  forge.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function screenText(make: (s: ReturnType<typeof createForgeApp>["session"], c: ReturnType<typeof createForgeApp>["app"]["ctx"]) => ReturnType<typeof feedScreen>): Promise<string> {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", user: alice },
    { terminal: headlessTerminal(140, 44), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(make(session, app.ctx));
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

const said = () => stepLine(stepOfStored(forge.db, repo, one)!);

test("the terminal's feed prints the step line under a pull's post", async () => {
  expect(said()).toStartWith("Review — ");
  expect(await screenText((s, c) => feedScreen(s, c))).toContain(said());
});

test("the terminal's pulls list prints the step line under each pull", async () => {
  expect(await screenText((s, c) => issuesScreen(s, c, local(s, repo), "pull"))).toContain(said());
});

test("the terminal's on-you list prints the step line under a pull assigned to the viewer", async () => {
  expect(await screenText((s, c) => dashboardScreen(s, c))).toContain(said());
});
